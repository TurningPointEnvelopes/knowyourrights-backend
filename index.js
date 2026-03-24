const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Basic CORS so Netlify can call Railway
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// IMPORTANT: Raw body needed for Stripe webhook verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Supabase client with service role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'KnowYourRights.biz Backend Running ✅' });
});

// Railway health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── ASK AI ROUTE ──
app.post('/ask', async (req, res) => {
  try {
    const {
      question,
      lang,
      region,
      activeArea,
      activeSpecName,
      isPaidUser
    } = req.body || {};

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }

    if (!region || !region.trim()) {
      return res.status(400).json({ error: 'Region is required' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is missing in Railway variables' });
    }

    const systemPrompt =
      `You are ${activeSpecName || 'Victor'}, an expert AI legal research specialist focusing on ${activeArea || 'Corporate & Business Law'}. ` +
      `You have deep knowledge of laws, statutes, codes, regulations, and legal precedents for all 50 US states, federal US law, and legal systems in 200+ countries worldwide. ` +
      `CRITICAL RULES: ` +
      `1. Always respond in ${lang || 'English'}. ` +
      `2. Provide legal RESEARCH and INFORMATION only - not legal advice. ` +
      `3. Be specific to: ${region}. ` +
      `4. Reference relevant statutes by name when possible. ` +
      `5. Use clear plain language. ` +
      `6. Cover: Situation Analysis, Relevant Laws, Exact wording to use, What NOT to say, Step-by-step actions. ` +
      `7. Write at least 6-8 detailed paragraphs. ` +
      `8. End with disclaimer to consult a licensed attorney.`;

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content:
              `Location: ${region}\n` +
              `Area: ${activeArea || 'Corporate & Business Law'}\n` +
              `Language: ${lang || 'English'}\n` +
              `Paid User: ${isPaidUser ? 'Yes' : 'No'}\n` +
              `Question: ${question}`
          }
        ]
      })
    });

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      console.error('Anthropic API error:', data);
      return res.status(anthropicResponse.status).json({
        error: 'Anthropic API request failed',
        details: data
      });
    }

    let fullText = '';
    if (data.content && Array.isArray(data.content)) {
      for (const item of data.content) {
        if (item.text) fullText += item.text;
      }
    }

    if (!fullText) {
      return res.status(500).json({ error: 'No response text returned from Anthropic' });
    }

    return res.json({ answer: fullText });
  } catch (err) {
    console.error('/ask route error:', err);
    return res.status(500).json({
      error: 'Server error while processing question',
      details: err.message
    });
  }
});

// ── STRIPE WEBHOOK ──
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountPaid = session.amount_total;
    const paymentId = session.id;

    console.log(`Payment received from ${customerEmail} — $${amountPaid / 100}`);

    try {
      const { data: existing } = await supabase
        .from('subscribers')
        .select('*')
        .eq('email', customerEmail)
        .single();

      if (existing) {
        await supabase
          .from('subscribers')
          .update({
            active: true,
            amount_paid: amountPaid / 100,
            payment_id: paymentId,
            updated_at: new Date().toISOString()
          })
          .eq('email', customerEmail);
      } else {
        await supabase
          .from('subscribers')
          .insert({
            email: customerEmail,
            active: true,
            amount_paid: amountPaid / 100,
            payment_id: paymentId,
            created_at: new Date().toISOString()
          });
      }

      console.log(`✅ Subscriber activated: ${customerEmail}`);
    } catch (dbError) {
      console.error('Database error:', dbError);
    }
  }

  res.json({ received: true });
});

// ── CHECK SUBSCRIBER STATUS ──
app.get('/check-subscriber', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const { data, error } = await supabase
      .from('subscribers')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !data) {
      return res.json({ active: false });
    }

    return res.json({
      active: data.active,
      email: data.email,
      plan: data.plan || 'basic'
    });
  } catch (err) {
    return res.json({ active: false });
  }
});

// ── MANUAL ACTIVATE (for Cash App/Venmo/Chime payments) ──
app.post('/activate', async (req, res) => {
  const { email, plan, adminKey } = req.body;

  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: existing } = await supabase
      .from('subscribers')
      .select('*')
      .eq('email', email)
      .single();

    if (existing) {
      await supabase
        .from('subscribers')
        .update({ active: true, plan, updated_at: new Date().toISOString() })
        .eq('email', email);
    } else {
      await supabase
        .from('subscribers')
        .insert({
          email,
          active: true,
          plan,
          created_at: new Date().toISOString()
        });
    }

    return res.json({ success: true, message: `${email} activated on ${plan} plan` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KnowYourRights Backend running on port ${PORT}`);
});
