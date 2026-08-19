const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken, checkDailyLimit } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/subjects', async (req, res) => {
  try {
    const { data: subjects, error } = await supabase.from('subjects').select('*').eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, subjects });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get subjects' }); }
});

router.get('/topics/:subjectId', async (req, res) => {
  try {
    const { data: topics, error } = await supabase.from('topics').select('*').eq('subject_id', req.params.subjectId).eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, topics });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get topics' }); }
});

router.get('/exams', async (req, res) => {
  try {
    const { data: exams, error } = await supabase.from('exam_categories').select('*').eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, exams });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get exams' }); }
});

router.post('/start', verifyToken, checkDailyLimit('mcq'), async (req, res) => {
  try {
    const { subject_id, topic_id, exam_category_id, count = 10, difficulty } = req.body;
    let query = supabase.from('questions').select('*, question_options(*)').eq('is_published', true).eq('is_verified', true);
    if (subject_id) query = query.eq('subject_id', subject_id);
    if (topic_id) query = query.eq('topic_id', topic_id);
    if (exam_category_id) query = query.eq('exam_category_id', exam_category_id);
    if (difficulty) query = query.eq('difficulty', difficulty);
    const { data: attempted } = await supabase.from('question_attempts').select('question_id, is_correct').eq('user_id', req.user.id);
    const wrongIds = attempted?.filter(a => !a.is_correct).map(a => a.question_id) || [];
    const attemptedIds = attempted?.map(a => a.question_id) || [];
    query = query.limit(count * 3);
    const { data: allQuestions, error } = await query;
    if (error) throw error;
    if (!allQuestions || allQuestions.length === 0) return res.status(404).json({ success: false, message: 'No questions found' });
    const unseen = allQuestions.filter(q => !attemptedIds.includes(q.id));
    const wrong = allQuestions.filter(q => wrongIds.includes(q.id));
    const rest = allQuestions.filter(q => attemptedIds.includes(q.id) && !wrongIds.includes(q.id));
    let selected = [...unseen, ...wrong, ...rest].slice(0, count).sort(() => Math.random() - 0.5);
    const questions = selected.map(q => ({ ...q, question_options: q.question_options.sort(() => Math.random() - 0.5) }));
    const { data: session, error: sessionError } = await supabase.from('practice_sessions').insert({ user_id: req.user.id, subject_id: subject_id || null, topic_id: topic_id || null, exam_category_id: exam_category_id || null, total_questions: questions.length }).select().single();
    if (sessionError) throw sessionError;
    res.json({ success: true, session_id: session.id, total_questions: questions.length, questions });
  } catch (error) {
    console.error('Start MCQ error:', error);
    res.status(500).json({ success: false, message: 'Failed to start practice' });
  }
});

router.post('/answer', verifyToken, async (req, res) => {
  try {
    const { session_id, question_id, selected_option_id, time_taken_seconds, subject_id } = req.body;
    const { data: option } = await supabase.from('question_options').select('is_correct').eq('id', selected_option_id).single();
    const is_correct = option?.is_correct || false;
    await supabase.from('question_attempts').insert({ user_id: req.user.id, question_id, session_id, selected_option_id, is_correct, time_taken_seconds });
    const today = new Date().toISOString().split('T')[0];
    const { data: limits } = await supabase.from('daily_limits').select('mcq_count').eq('user_id', req.user.id).eq('date', today).single();
    await supabase.from('daily_limits').upsert({ user_id: req.user.id, date: today, mcq_count: (limits?.mcq_count || 0) + 1 });
    if (subject_id) {
      const { data: perf } = await supabase.from('user_subject_performance').select('*').eq('user_id', req.user.id).eq('subject_id', subject_id).single();
      if (perf) {
        const newTotal = perf.total_attempted + 1;
        const newCorrect = perf.total_correct + (is_correct ? 1 : 0);
        await supabase.from('user_subject_performance').update({ total_attempted: newTotal, total_correct: newCorrect, accuracy: (newCorrect / newTotal) * 100, last_practiced_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('subject_id', subject_id);
      } else {
        await supabase.from('user_subject_performance').insert({ user_id: req.user.id, subject_id, total_attempted: 1, total_correct: is_correct ? 1 : 0, accuracy: is_correct ? 100 : 0, last_practiced_at: new Date().toISOString() });
      }
    }
    const { data: question } = await supabase.from('questions').select('explanation, question_options(*)').eq('id', question_id).single();
    res.json({ success: true, is_correct, correct_option: question?.question_options?.find(o => o.is_correct), explanation: question?.explanation });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to submit answer' });
  }
});

router.post('/complete', verifyToken, async (req, res) => {
  try {
    const { session_id } = req.body;
    const { data: attempts } = await supabase.from('question_attempts').select('is_correct').eq('session_id', session_id).eq('user_id', req.user.id);
    const total = attempts?.length || 0;
    const correct = attempts?.filter(a => a.is_correct).length || 0;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    await supabase.from('practice_sessions').update({ correct_count: correct, wrong_count: total - correct, accuracy, completed: true }).eq('id', session_id).eq('user_id', req.user.id);
    await supabase.from('xp_transactions').insert({ user_id: req.user.id, amount: correct * 2, type: 'mcq_practice', description: `Completed practice: ${correct}/${total} correct` });
    res.json({ success: true, result: { total, correct, wrong: total - correct, accuracy: accuracy.toFixed(2), xp_earned: correct * 2 } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to complete session' });
  }
});

router.get('/limit-status', verifyToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: subscription } = await supabase.from('subscriptions').select('*').eq('user_id', req.user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
    if (subscription) return res.json({ success: true, is_premium: true, mcq_limit: -1, mcq_used: 0, mock_limit: -1, mock_used: 0 });
    const { data: limits } = await supabase.from('daily_limits').select('*').eq('user_id', req.user.id).eq('date', today).single();
    res.json({ success: true, is_premium: false, mcq_limit: 50, mcq_used: limits?.mcq_count || 0, mock_limit: 2, mock_used: limits?.mock_count || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get limit status' });
  }
});

module.exports = router;
