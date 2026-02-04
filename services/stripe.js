import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_ID_MONTHLY,
  yearly: process.env.STRIPE_PRICE_ID_YEARLY
}

/**
 * Create or retrieve Stripe customer for user
 */
export async function getOrCreateCustomer(userId, email) {
  try {
    // Check if customer already exists in Supabase
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single()

    if (subscription?.stripe_customer_id) {
      return subscription.stripe_customer_id
    }

    // Create new Stripe customer
    const customer = await stripe.customers.create({
      email,
      metadata: {
        supabase_user_id: userId
      }
    })

    return customer.id
  } catch (error) {
    console.error('Error getting/creating customer:', error)
    throw error
  }
}

/**
 * Create subscription with 3-day trial
 */
export async function createSubscription(userId, email, planType) {
  try {
    console.log(`Creating ${planType} subscription for user ${userId}`)

    // Get or create Stripe customer
    const customerId = await getOrCreateCustomer(userId, email)

    // Get price ID for plan
    const priceId = PRICE_IDS[planType]
    if (!priceId) {
      throw new Error(`Invalid plan type: ${planType}`)
    }

    // Create subscription with 3-day trial
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: 3,
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        supabase_user_id: userId,
        plan_type: planType
      }
    })

    // Store subscription in Supabase
    const trialEndDate = new Date(subscription.trial_end * 1000)
    const periodStart = new Date(subscription.current_period_start * 1000)
    const periodEnd = new Date(subscription.current_period_end * 1000)

    await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        plan_type: planType,
        status: subscription.status,
        trial_ends_at: trialEndDate.toISOString(),
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        cancel_at_period_end: subscription.cancel_at_period_end
      })

    console.log(`✅ Subscription created: ${subscription.id}`)

    return {
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      status: subscription.status
    }
  } catch (error) {
    console.error('Error creating subscription:', error)
    throw error
  }
}

/**
 * Start free trial (without payment method)
 */
export async function startFreeTrial(userId, email) {
  try {
    console.log(`Starting free trial for user ${userId}`)

    const trialEndDate = new Date()
    trialEndDate.setDate(trialEndDate.getDate() + 3) // 3 days from now

    // Store trial in Supabase
    await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        plan_type: 'trial',
        status: 'trialing',
        trial_ends_at: trialEndDate.toISOString(),
        current_period_start: new Date().toISOString(),
        current_period_end: trialEndDate.toISOString()
      })

    console.log(`✅ Free trial started, expires: ${trialEndDate}`)

    return {
      status: 'trialing',
      trialEndsAt: trialEndDate.toISOString()
    }
  } catch (error) {
    console.error('Error starting trial:', error)
    throw error
  }
}

/**
 * Cancel subscription
 */
export async function cancelSubscription(userId) {
  try {
    console.log(`Canceling subscription for user ${userId}`)

    // Get subscription from Supabase
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .single()

    if (!sub?.stripe_subscription_id) {
      throw new Error('No subscription found')
    }

    // Cancel at period end (not immediately)
    const subscription = await stripe.subscriptions.update(
      sub.stripe_subscription_id,
      { cancel_at_period_end: true }
    )

    // Update Supabase
    await supabase
      .from('subscriptions')
      .update({ cancel_at_period_end: true })
      .eq('user_id', userId)

    console.log(`✅ Subscription will cancel at period end`)

    return { success: true, cancelAtPeriodEnd: true }
  } catch (error) {
    console.error('Error canceling subscription:', error)
    throw error
  }
}

/**
 * Get subscription status for user
 */
export async function getSubscriptionStatus(userId) {
  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (error || !subscription) {
      return {
        hasSubscription: false,
        status: 'none',
        planType: null
      }
    }

    // Check if trial has expired
    if (subscription.status === 'trialing' && subscription.trial_ends_at) {
      const trialEnd = new Date(subscription.trial_ends_at)
      if (trialEnd < new Date()) {
        // Trial expired
        await supabase
          .from('subscriptions')
          .update({ status: 'expired' })
          .eq('user_id', userId)

        return {
          hasSubscription: false,
          status: 'expired',
          planType: subscription.plan_type,
          trialExpired: true
        }
      }
    }

    const hasAccess = ['active', 'trialing'].includes(subscription.status)

    return {
      hasSubscription: hasAccess,
      status: subscription.status,
      planType: subscription.plan_type,
      trialEndsAt: subscription.trial_ends_at,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end
    }
  } catch (error) {
    console.error('Error getting subscription status:', error)
    throw error
  }
}

/**
 * Handle Stripe webhook events
 */
export async function handleWebhook(event) {
  try {
    console.log(`📨 Webhook received: ${event.type}`)

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object)
        break

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object)
        break

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object)
        break

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return { received: true }
  } catch (error) {
    console.error('Webhook error:', error)
    throw error
  }
}

async function handleSubscriptionUpdate(subscription) {
  const userId = subscription.metadata.supabase_user_id
  if (!userId) return

  const periodStart = new Date(subscription.current_period_start * 1000)
  const periodEnd = new Date(subscription.current_period_end * 1000)
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null

  await supabase
    .from('subscriptions')
    .update({
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      trial_ends_at: trialEnd?.toISOString(),
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end
    })
    .eq('user_id', userId)

  console.log(`✅ Subscription updated for user ${userId}`)
}

async function handleSubscriptionDeleted(subscription) {
  const userId = subscription.metadata.supabase_user_id
  if (!userId) return

  await supabase
    .from('subscriptions')
    .update({ status: 'canceled' })
    .eq('user_id', userId)

  console.log(`✅ Subscription canceled for user ${userId}`)
}

async function handlePaymentSucceeded(invoice) {
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription)
  const userId = subscription.metadata.supabase_user_id
  if (!userId) return

  await supabase
    .from('subscriptions')
    .update({ status: 'active' })
    .eq('user_id', userId)

  console.log(`✅ Payment succeeded for user ${userId}`)
}

async function handlePaymentFailed(invoice) {
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription)
  const userId = subscription.metadata.supabase_user_id
  if (!userId) return

  await supabase
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('user_id', userId)

  console.log(`⚠️ Payment failed for user ${userId}`)
}
