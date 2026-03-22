const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Supabase client with service role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// IMPORTANT: Raw body needed for Stripe webhook verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'KnowYourRights.biz Backend Running ✅' });
});

// Railway health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
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
      // Check if user exists in subscribers table
      const { data: existing } = await supabase
        .from('subscribers')
        .select('*')
        .eq('email', customerEmail)
        .single();

      if (existing) {
        // Update existing subscriber
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
        // Create new subscriber
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

  // Simple admin protection
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
