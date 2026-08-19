const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const OpenAI = require('openai');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/tutor/chat', verifyToken, async (req, res) => {
  try {
    const { message, conversation_id, mode = 'normal', subject_id } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });
    const { data: subscription } = await supabase.from('subscriptions').select('*').eq('user_id', req.user.id).eq('status', 'active').gt('end_date', new Date().toISOString()).single();
    const isPremium = !!subscription;
    const today = new Date().toISOString().split('T')[0];
    if (!isPremium) {
      const { data: limits } = await supabase.from('daily_limits').select('ai_requests').eq('user_id', req.user.id).eq('date', today).single();
      if (limits && limits.ai_requests >= 10) return res.status(429).json({ success: false, message: 'Daily AI limit reached. Upgrade to Premium.', upgrade_url: '/premium' });
    }
    let convId = conversation_id;
    if (!convId) {
      const { data: conv } = await supabase.from('ai_conversations').insert({ user_id: req.user.id, title: message.substring(0, 50), mode, subject_id: subject_id || null }).select().single();
      convId = conv.id;
    }
    const { data: history } = await supabase.from('ai_messages').select('role, content').eq('conversation_id', convId).order('created_at', { ascending: true }).limit(10);
    const systemPrompts = {
      normal: 'You are an expert nursing tutor for Indian nursing students. Help with nursing concepts and exam preparation (NORCET, AIIMS, State Nurse). Respond in Hindi, English, or Hinglish as needed.',
      exam: 'You are a nursing exam coach. Give direct, exam-focused answers for NORCET, AIIMS, State Nurse exams. Be concise.',
      beginner: 'You are a friendly nursing tutor for beginners. Use simple language and relatable examples.',
      deep: 'You are an advanced nursing educator. Provide detailed explanations with pathophysiology and evidence-based information.',
      revision: 'You are a revision assistant. Provide bullet-point summaries, mnemonics, and key points.'
    };
    const messages = [{ role: 'system', content: systemPrompts[mode] || systemPrompts.normal }, ...(history || []), { role: 'user', content: message }];
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: isPremium ? 1000 : 500, temperature: 0.7 });
    const reply = completion.choices[0].message.content;
    await supabase.from('ai_messages').insert([{ conversation_id: convId, role: 'user', content: message, tokens_used: 0 }, { conversation_id: convId, role: 'assistant', content: reply, tokens_used: completion.usage.total_tokens, ai_model: 'gpt-4o-mini' }]);
    const { data: limits } = await supabase.from('daily_limits').select('ai_requests').eq('user_id', req.user.id).eq('date', today).single();
    await supabase.from('daily_limits').upsert({ user_id: req.user.id, date: today, ai_requests: (limits?.ai_requests || 0) + 1 });
    res.json({ success: true, reply, conversation_id: convId });
  } catch (error) {
    console.error('AI tutor error:', error);
    res.status(500).json({ success: false, message: 'AI tutor unavailable' });
  }
});

router.post('/study-plan', verifyToken, async (req, res) => {
  try {
    const { exam_name, exam_date, daily_hours, subjects, weak_topics, current_level = 'beginner' } = req.body;
    if (!exam_name || !exam_date || !daily_hours) return res.status(400).json({ success: false, message: 'Exam name, date and daily hours required' });
    const daysLeft = Math.ceil((new Date(exam_date) - new Date()) / (1000 * 60 * 60 * 24));
    const prompt = `Create a nursing exam study plan in JSON:\n{"overview":"brief overview","daily_target":{"mcq_count":50,"study_hours":${daily_hours},"mock_tests_per_week":2},"weekly_schedule":[{"week":1,"focus":"focus area","subjects":["subject1"]}],"priority_topics":["topic1","topic2"],"tips":["tip1","tip2"]}\n\nExam: ${exam_name}, Days left: ${daysLeft}, Daily hours: ${daily_hours}, Subjects: ${subjects?.join(', ')}, Weak topics: ${weak_topics?.join(', ')}, Level: ${current_level}`;
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 2000 });
    const planData = JSON.parse(completion.choices[0].message.content);
    const { data: plan } = await supabase.from('study_plans').insert({ user_id: req.user.id, title: `${exam_name} Study Plan`, exam_name, exam_date, daily_hours, subjects: subjects || [], weak_topics: weak_topics || [], plan_data: planData, ai_model: 'gpt-4o-mini' }).select().single();
    res.json({ success: true, plan_id: plan.id, plan: planData });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate study plan' });
  }
});

router.post('/flashcards/generate', verifyToken, async (req, res) => {
  try {
    const { topic, subject_id, count = 10 } = req.body;
    if (!topic) return res.status(400).json({ success: false, message: 'Topic required' });
    const prompt = `Generate ${count} nursing flashcards for "${topic}" in JSON:\n{"deck_title":"title","flashcards":[{"front":"question","back":"answer","hint":"optional hint"}]}\nFocus on Indian nursing exams (NORCET, AIIMS).`;
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 2000 });
    const data = JSON.parse(completion.choices[0].message.content);
    const { data: deck } = await supabase.from('flashcard_decks').insert({ user_id: req.user.id, title: data.deck_title || topic, subject_id: subject_id || null, total_cards: data.flashcards.length, is_ai_generated: true }).select().single();
    await supabase.from('flashcards').insert(data.flashcards.map((f, i) => ({ deck_id: deck.id, front_text: f.front, back_text: f.back, hint: f.hint || null, display_order: i + 1 })));
    res.json({ success: true, deck_id: deck.id, deck_title: data.deck_title, flashcards: data.flashcards, total: data.flashcards.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate flashcards' });
  }
});

router.post('/generate-mcqs', verifyToken, async (req, res) => {
  try {
    const { subject_id, topic_id, difficulty = 'medium', count = 5 } = req.body;
    const { data: subject } = await supabase.from('subjects').select('name').eq('id', subject_id).single();
    const prompt = `Generate ${count} nursing MCQs for ${subject?.name || 'Nursing'} (${difficulty}) in JSON:\n{"questions":[{"question_text":"question?","options":[{"text":"A","is_correct":false},{"text":"B","is_correct":true},{"text":"C","is_correct":false},{"text":"D","is_correct":false}],"explanation":"why correct","difficulty":"${difficulty}","quality_score":85}]}\nOnly one correct answer per question. Focus on Indian nursing exams.`;
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 3000 });
    const data = JSON.parse(completion.choices[0].message.content);
    const { data: job } = await supabase.from('ai_jobs').insert({ job_type: 'mcq_generation', status: 'processing', subject_id, topic_id: topic_id || null, difficulty, target_count: count, ai_model: 'gpt-4o-mini', tokens_used: completion.usage.total_tokens }).select().single();
    let savedCount = 0;
    for (const q of data.questions) {
      if (q.quality_score >= 70) {
        const { data: question } = await supabase.from('questions').insert({ subject_id, topic_id: topic_id || null, question_text: q.question_text, difficulty: q.difficulty || difficulty, explanation: q.explanation, ai_generated: true, ai_model: 'gpt-4o-mini', quality_score: q.quality_score, is_verified: false, is_published: false }).select().single();
        if (question) { await supabase.from('question_options').insert(q.options.map((o, i) => ({ question_id: question.id, option_text: o.text, is_correct: o.is_correct, display_order: i + 1 }))); savedCount++; }
      }
    }
    await supabase.from('ai_jobs').update({ status: 'completed', generated_count: data.questions.length, approved_count: savedCount, completed_at: new Date().toISOString() }).eq('id', job.id);
    res.json({ success: true, generated: data.questions.length, saved: savedCount, message: `${savedCount} questions saved for review` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate MCQs' });
  }
});

router.get('/conversations', verifyToken, async (req, res) => {
  try {
    const { data: conversations } = await supabase.from('ai_conversations').select('*').eq('user_id', req.user.id).eq('is_active', true).order('updated_at', { ascending: false }).limit(20);
    res.json({ success: true, conversations });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get conversations' }); }
});

router.get('/conversations/:id', verifyToken, async (req, res) => {
  try {
    const { data: messages } = await supabase.from('ai_messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true });
    res.json({ success: true, messages });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get messages' }); }
});

router.get('/study-plans', verifyToken, async (req, res) => {
  try {
    const { data: plans } = await supabase.from('study_plans').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false });
    res.json({ success: true, plans });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get study plans' }); }
});

router.get('/flashcards', verifyToken, async (req, res) => {
  try {
    const { data: decks } = await supabase.from('flashcard_decks').select('*, subjects(name)').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json({ success: true, decks });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get flashcard decks' }); }
});

router.get('/flashcards/:deckId', verifyToken, async (req, res) => {
  try {
    const { data: flashcards } = await supabase.from('flashcards').select('*').eq('deck_id', req.params.deckId).order('display_order');
    res.json({ success: true, flashcards });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to get flashcards' }); }
});

module.exports = router;
