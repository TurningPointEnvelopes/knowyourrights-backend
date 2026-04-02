cconst express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// IMPORTANT: raw body required for Stripe webhook verification
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  res.sendStatus(200);
});

// ── SUPABASE ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── HEALTH / ROOT ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'KnowYourRights.biz Backend Running ✅',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getPlanFromAmount(amountPaid) {
  if (amountPaid === 2900) return 'basic';
  if (amountPaid === 5900) return 'pro';
  if (amountPaid === 9900) return 'family';
  return 'basic';
}

// ── ASK ROUTE ───────────────────────────────────────────────────────────────
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
      return res
        .status(500)
        .json({ error: 'ANTHROPIC_API_KEY is missing in Railway variables' });
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
        model: 'claude-opus-4-6',
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

// ── STRIPE WEBHOOK ──────────────────────────────────────────────────────────
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

  try {
    // Successful checkout payment
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerEmail = session.customer_details?.email || session.customer_email;
      const amountPaid = session.amount_total || 0;
      const paymentId = session.id;
      const plan = getPlanFromAmount(amountPaid);

      if (!customerEmail) {
        console.error('No customer email found in checkout session');
        return res.json({ received: true });
      }

      console.log(
        `Payment received from ${customerEmail} — $${amountPaid / 100} — plan: ${plan}`
      );

      const { data: existing, error: fetchError } = await supabase
        .from('subscribers')
        .select('*')
        .eq('email', customerEmail)
        .maybeSingle();

      if (fetchError) {
        console.error('Supabase fetch error:', fetchError);
      }

      if (existing) {
        const { error: updateError } = await supabase
          .from('subscribers')
          .update({
            active: true,
            plan: plan,
            amount_paid: amountPaid / 100,
            payment_id: paymentId,
            updated_at: new Date().toISOString()
          })
          .eq('email', customerEmail);

        if (updateError) {
          console.error('Supabase update error:', updateError);
        }
      } else {
        const { error: insertError } = await supabase
          .from('subscribers')
          .insert({
            email: customerEmail,
            active: true,
            plan: plan,
            amount_paid: amountPaid / 100,
            payment_id: paymentId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });

        if (insertError) {
          console.error('Supabase insert error:', insertError);
        }
      }

      console.log(`✅ Subscriber activated: ${customerEmail} on ${plan}`);
    }

    // Optional: deactivate canceled subscriptions
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      if (customerId) {
        const customers = await stripe.customers.list({ limit: 1, email: undefined });
        console.log('Subscription deleted event received for customer:', customerId);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── CHECK SUBSCRIBER STATUS ────────────────────────────────────────────────
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
      .maybeSingle();

    if (error || !data) {
      return res.json({ active: false });
    }

    return res.json({
      active: !!data.active,
      email: data.email,
      plan: data.plan || 'basic',
      amount_paid: data.amount_paid || 0
    });
  } catch (err) {
    console.error('/check-subscriber error:', err);
    return res.json({ active: false });
  }
});

// ── MANUAL ACTIVATE (Cash App / Venmo / manual payments) ───────────────────
app.post('/activate', async (req, res) => {
  const { email, plan, adminKey } = req.body || {};

  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!email || !plan) {
    return res.status(400).json({ error: 'Email and plan are required' });
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('subscribers')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (fetchError) {
      console.error('Manual activation fetch error:', fetchError);
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('subscribers')
        .update({
          active: true,
          plan,
          updated_at: new Date().toISOString()
        })
        .eq('email', email);

      if (updateError) {
        throw updateError;
      }
    } else {
      const { error: insertError } = await supabase
        .from('subscribers')
        .insert({
          email,
          active: true,
          plan,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) {
        throw insertError;
      }
    }

    return res.json({
      success: true,
      message: `${email} activated on ${plan} plan`
    });
  } catch (err) {
    console.error('/activate error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KnowYourRights Backend running on port ${PORT}`);
});