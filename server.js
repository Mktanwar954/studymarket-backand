require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'JT-EDUVERSE API is running!', version: '1.0.0' });
});

app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/mcq', require('./routes/mcq'));
app.use('/api/v1/mock', require('./routes/mock'));
app.use('/api/v1/marketplace', require('./routes/marketplace'));
app.use('/api/v1/payments', require('./routes/payments'));
app.use('/api/v1/ai', require('./routes/ai'));
app.use('/api/v1/community', require('./routes/community'));
app.use('/api/v1/admin', require('./routes/admin'));
app.use('/api/v1/notifications', require('./routes/notifications'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => { console.log(`JT-EDUVERSE API running on port ${PORT}`); });

module.exports = { app, supabase };
