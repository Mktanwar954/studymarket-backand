const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

router.post('/premium/create-order', verifyToken, async (req, res) => {
  try {
    const { plan_id = 2 } = req.body;
    const { data: plan } = await supabase.from('subscription_plans').select('*').eq('id', plan_id).single();
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    const order = await razorpay.orders.create({ amount: plan.price * 100, currency: 'INR', receipt: `premium_${req.user.id}_${Date.now()}`, notes: { user_id: req.user.id, plan_id: plan.id } });
    await supabase.from('payments').insert({ user_id: req.user.id, type: 'premium_subscription', amount: plan.price, currency: 'INR', status: 'pending', razorpay_order_id: order.id, metadata: { plan_id } });
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, plan: { name: plan.name, price: plan.price, duration_days: plan.duration_days }, razorpay_key: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
});

router.post('/premium/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id = 2 } = req.body;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expectedSignature !== razorpay_signature) return res.status(400).json({ success: false, message: 'Payment verification failed' });
    const { data: plan } = await supabase.from('subscription_plans').select('*').eq('id', plan_id).single();
    await supabase.from('payments').update({ status: 'completed', razorpay_payment_id, razorpay_signature }).eq('razorpay_order_id', razorpay_order_id);
    await supabase.from('subscriptions').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('status', 'active');
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + plan.duration_days);
    const { data: subscription } = await supabase.from('subscriptions').insert({ user_id: req.user.id, plan_id, status: 'active', start_date: new Date().toISOString(), end_date: endDate.toISOString() }).select().single();
    await supabase.from('users').update({ role_id: 2 }).eq('id', req.user.id);
    await supabase.from('notifications').insert({ user_id: req.user.id, title: '🎉 Premium Activated!', message: `Welcome to JT-EDUVERSE Premium! Enjoy unlimited access for ${plan.duration_days} days.`, type: 'premium_activated' });
    res.json({ success: true, message: 'Premium activated successfully!', subscription: { id: subscription.id, plan: plan.name, end_date: endDate.toISOString() } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Payment verification failed' });
  }
});

router.get('/history', verifyToken, async (req, res) => {
  try {
    const { data: payments } = await supabase.from('payments').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json({ success: true, payments });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get payment history' });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(req.body).digest('hex');
    if (signature !== expectedSignature) return res.status(400).json({ success: false });
    const event = JSON.parse(req.body);
    if (event.event === 'payment.failed') {
      await supabase.from('payments').update({ status: 'failed' }).eq('razorpay_order_id', event.payload.payment.entity.order_id);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
