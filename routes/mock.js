const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken, checkDailyLimit } = require('../middleware/auth');
const OpenAI = require('openai');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/generate', verifyToken, checkDailyLimit('mock'), async (req, res) => {
  try {
    const { exam_category_id, total_questions = 100, duration_minutes = 90 } = req.body;
    const isPremium = !!req.subscription;
    const finalCount = isPremium ? total_questions : 50;
    const distribution = { 'Medical-Surgical Nursing': 25, 'Pharmacology': 15, 'Fundamentals of Nursing': 10, 'Obstetric & Gynecological Nursing': 10, 'Child Health Nursing': 10, 'Mental Health Nursing': 10, 'Community Health Nursing': 10, 'Other': 10 };
    let allQuestions = [];
    for (const [subjectName, count] of Object.entries(distribution)) {
      const { data: subject } = await supabase.from('subjects').select('id').ilike('name', `%${subjectName}%`).single();
      if (!subject) continue;
      let query = supabase.from('questions').select('*, question_options(*)').eq('is_published', true).eq('is_verified', true).eq('subject_id', subject.id);
      if (exam_category_id) query = query.eq('exam_category_id', exam_category_id);
      const { data: questions } = await query.limit(count * 2);
      if (questions && questions.length > 0) allQuestions = [...allQuestions, ...questions.sort(() => Math.random() - 0.5).slice(0, count)];
    }
    if (allQuestions.length === 0) return res.status(404).json({ success: false, message: 'Not enough questions available' });
    allQuestions = allQuestions.sort(() => Math.random() - 0.5);
    const { data: mockTest, error: mockError } = await supabase.from('mock_tests').insert({ title: `Mock Test - ${new Date().toLocaleDateString()}`, total_questions: allQuestions.length, duration_minutes: isPremium ? duration_minutes : 60, is_auto_generated: true, exam_category_id: exam_category_id || null }).select().single();
    if (mockError) throw mockError;
    await supabase.from('mock_test_questions').insert(allQuestions.map((q, i) => ({ mock_test_id: mockTest.id, question_id: q.id, display_order: i + 1, marks: 1, negative_marks: 0 })));
    const { data: attempt, error: attemptError } = await supabase.from('mock_test_attempts').insert({ user_id: req.user.id, mock_test_id: mockTest.id, total_questions: allQuestions.length, status: 'in_progress' }).select().single();
    if (attemptError) throw attemptError;
    const questions = allQuestions.map((q, i) => ({ ...q, display_order: i + 1, question_options: q.question_options.map(o => ({ id: o.id, option_text: o.option_text })).sort(() => Math.random() - 0.5) }));
    res.json({ success: true, attempt_id: attempt.id, mock_test_id: mockTest.id, total_questions: questions.length, duration_minutes: isPremium ? duration_minutes : 60, questions });
  } catch (error) {
    console.error('Generate mock error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate mock test' });
  }
});

router.post('/answer', verifyToken, async (req, res) => {
  try {
    const { attempt_id, question_id, selected_option_id, is_marked_for_review, time_taken_seconds } = req.body;
    const { data: option } = await supabase.from('question_options').select('is_correct').eq('id', selected_option_id).single();
    const is_correct = option?.is_correct || false;
    await supabase.from('mock_test_answers').upsert({ attempt_id, question_id, selected_option_id, is_marked_for_review: is_marked_for_review || false, is_correct, marks_obtained: is_correct ? 1 : 0, time_taken_seconds }, { onConflict: 'attempt_id,question_id' });
    const { data: answers } = await supabase.from('mock_test_answers').select('id').eq('attempt_id', attempt_id).not('selected_option_id', 'is', null);
    await supabase.from('mock_test_attempts').update({ answered_count: answers?.length || 0 }).eq('id', attempt_id);
    res.json({ success: true, is_correct });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to save answer' });
  }
});

router.post('/submit', verifyToken, async (req, res) => {
  try {
    const { attempt_id } = req.body;
    const { data: attempt } = await supabase.from('mock_test_attempts').select('*, mock_tests(*)').eq('id', attempt_id).eq('user_id', req.user.id).single();
    if (!attempt) return res.status(404).json({ success: false, message: 'Attempt not found' });
    const { data: answers } = await supabase.from('mock_test_answers').select('*, questions(subject_id)').eq('attempt_id', attempt_id);
    const total = attempt.total_questions;
    const correct = answers?.filter(a => a.is_correct).length || 0;
    const wrong = answers?.filter(a => !a.is_correct && a.selected_option_id).length || 0;
    const skipped = total - (answers?.length || 0);
    const percentage = (correct / total) * 100;
    const subjectWise = {};
    answers?.forEach(a => {
      const sid = a.questions?.subject_id;
      if (!sid) return;
      if (!subjectWise[sid]) subjectWise[sid] = { total: 0, correct: 0 };
      subjectWise[sid].total++;
      if (a.is_correct) subjectWise[sid].correct++;
    });
    const { data: result } = await supabase.from('mock_test_results').insert({ attempt_id, user_id: req.user.id, mock_test_id: attempt.mock_test_id, total_questions: total, correct_count: correct, wrong_count: wrong, skipped_count: skipped, total_marks: total, obtained_marks: correct, percentage, accuracy: answers?.length > 0 ? (correct / answers.length) * 100 : 0, subject_wise_result: subjectWise }).select().single();
    await supabase.from('mock_test_attempts').update({ status: 'completed', submitted_at: new Date().toISOString() }).eq('id', attempt_id);
    const today = new Date().toISOString().split('T')[0];
    const { data: limits } = await supabase.from('daily_limits').select('mock_count').eq('user_id', req.user.id).eq('date', today).single();
    await supabase.from('daily_limits').upsert({ user_id: req.user.id, date: today, mock_count: (limits?.mock_count || 0) + 1 });
    await supabase.from('xp_transactions').insert({ user_id: req.user.id, amount: Math.floor(percentage), type: 'mock_test', description: `Mock test: ${percentage.toFixed(1)}%` });
    let certificate = null;
    if (percentage >= 90) {
      const certNumber = 'JTE' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
      const { data: cert } = await supabase.from('certificates').insert({ user_id: req.user.id, attempt_id, certificate_number: certNumber, exam_name: attempt.mock_tests?.title, score: correct, percentage }).select().single();
      certificate = cert;
    }
    res.json({ success: true, result: { id: result.id, total_questions: total, correct, wrong, skipped, percentage: percentage.toFixed(2), xp_earned: Math.floor(percentage), certificate: certificate ? { number: certificate.certificate_number, verify_url: `/verify/${certificate.certificate_number}` } : null } });
  } catch (error) {
    console.error('Submit mock error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit test' });
  }
});

router.get('/result/:resultId', verifyToken, async (req, res) => {
  try {
    const { data: result } = await supabase.from('mock_test_results').select('*').eq('id', req.params.resultId).eq('user_id', req.user.id).single();
    if (!result) return res.status(404).json({ success: false, message: 'Result not found' });
    const { data: existingAnalysis } = await supabase.from('ai_result_analysis').select('*').eq('result_id', result.id).single();
    if (existingAnalysis) return res.json({ success: true, result, analysis: existingAnalysis });
    const prompt = `Analyze this nursing mock test result and return JSON:\n{"analysis_text":"2-3 sentence assessment","strongest_subject":"subject","weakest_subject":"subject","weak_topics":["topic1","topic2"],"strong_topics":["topic1"],"recommendations":["rec1","rec2","rec3"]}\n\nScore: ${result.correct_count}/${result.total_questions} (${result.percentage}%)\nCorrect: ${result.correct_count}, Wrong: ${result.wrong_count}, Skipped: ${result.skipped_count}`;
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 500 });
    const analysisData = JSON.parse(completion.choices[0].message.content);
    const { data: analysis } = await supabase.from('ai_result_analysis').insert({ result_id: result.id, user_id: req.user.id, ...analysisData, ai_model: 'gpt-4o-mini', tokens_used: completion.usage.total_tokens }).select().single();
    res.json({ success: true, result, analysis });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get result' });
  }
});

router.get('/history', verifyToken, async (req, res) => {
  try {
    const { data: results } = await supabase.from('mock_test_results').select('*, mock_tests(title, total_questions)').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get history' });
  }
});

module.exports = router;
