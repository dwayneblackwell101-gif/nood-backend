/**
 * Style Challenges API — shared UGC contests via Supabase.
 * Submissions and votes are stored server-side so ALL users see the same
 * entries and counts (not just per-device).
 *
 * Supabase tables (see supabase-setup.sql):
 *   style_challenges       (id text PK, theme, subtitle, emoji, prize_usd, ends_at, active)
 *   challenge_submissions  (id uuid PK, challenge_id, user_id, username, photo_uri, caption, created_at)
 *   challenge_votes        (challenge_id, submission_id, user_id, PK(submission_id, user_id))
 */

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../utils/supabase');
const { supabaseAdmin } = require('../utils/supabase-admin');
const { authenticateCustomer } = require('../services/customer-auth');
const { requireAdmin } = require('../utils/admin-auth');
const { fireRewardNotification } = require('../utils/notification-triggers');

const router = express.Router();
const { uploadChallengePhoto } = require('../services/challenge-photo');

router.post('/api/challenges/photo', async (req, res) => {
  const customer = await authenticateCustomer(req);
  if (!customer?.userId) return res.status(401).json({ success: false, message: 'Sign in to upload a photo.' });
  if (!supabaseAdmin) return res.status(503).json({ success: false, message: 'Photo uploads are temporarily unavailable.' });
  try {
    const photoUri = await uploadChallengePhoto(supabaseAdmin.storage, customer.userId, req.body?.base64);
    return res.json({ success: true, photoUri });
  } catch (error) {
    console.error('[CHALLENGES] photo upload failed:', error.message);
    return res.status(400).json({ success: false, message: 'Photo upload failed. Use a JPEG, PNG, or WebP photo under 600 KB and try again.' });
  }
});

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** GET /api/challenges — list all challenges (with submission counts). */
router.get('/api/challenges', async (req, res) => {
  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', challenges: [] });
  }

  try {
    const { data: challenges } = await supabase
      .from('style_challenges')
      .select('id, theme, subtitle, emoji, prize_usd, ends_at, active')
      .order('created_at', { ascending: true });

    return res.json({
      success: true,
      source: 'supabase',
      challenges: (challenges || []).map((c) => ({
        id: c.id,
        theme: c.theme,
        subtitle: c.subtitle,
        emoji: c.emoji,
        prizeUsd: Number(c.prize_usd || 0),
        endsAt: c.ends_at,
        active: Boolean(c.active),
      })),
    });
  } catch (error) {
    console.error('[CHALLENGES] list error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load challenges' });
  }
});

/** GET /api/challenges/:id/submissions — list submissions ranked by votes. */
router.get('/api/challenges/:id/submissions', async (req, res) => {
  const challengeId = safeString(req.params.id);
  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', submissions: [] });
  }

  try {
    const { data: submissions } = await supabase
      .from('challenge_submissions')
      .select('id, challenge_id, user_id, username, photo_uri, caption, created_at')
      .eq('challenge_id', challengeId);

    // Count votes per submission.
    const rows = submissions || [];
    const withVotes = await Promise.all(
      rows.map(async (s) => {
        const { count } = await supabase
          .from('challenge_votes')
          .select('*', { count: 'exact', head: true })
          .eq('submission_id', s.id);
        return {
          id: s.id,
          challengeId: s.challenge_id,
          userId: s.user_id,
          username: s.username,
          photoUri: s.photo_uri,
          caption: s.caption,
          votes: Number(count || 0),
          createdAt: s.created_at,
        };
      })
    );

    withVotes.sort((a, b) => b.votes - a.votes);

    return res.json({ success: true, source: 'supabase', submissions: withVotes });
  } catch (error) {
    console.error('[CHALLENGES] submissions error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load submissions' });
  }
});

/** POST /api/challenges/:id/submissions — add a submission. */
router.post('/api/challenges/:id/submissions', async (req, res) => {
  const challengeId = safeString(req.params.id);
  const customer = await authenticateCustomer(req);
  const userId = customer?.userId || '';
  const username = safeString([customer?.firstName, customer?.lastName].filter(Boolean).join(' '), 'NOOD customer');
  const photoUri = safeString(req.body?.photoUri);
  const caption = safeString(req.body?.caption, '');

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Signed-in identity required' });
  }
  if (!challengeId || !photoUri) {
    return res.status(400).json({ success: false, message: 'challengeId and photoUri are required' });
  }
  if (!/^https:\/\//i.test(photoUri)) return res.status(400).json({ success: false, message: 'Upload your photo before submitting.' });

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', submission: null });
  }

  try {
    // Prevent duplicate submissions per user per challenge.
    const { data: existing } = await supabase
      .from('challenge_submissions')
      .select('id')
      .eq('challenge_id', challengeId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      return res.json({ success: false, message: 'already_submitted', submission: null });
    }

    const { data, error } = await supabase
      .from('challenge_submissions')
      .insert({
        challenge_id: challengeId,
        user_id: userId,
        username,
        photo_uri: photoUri,
        caption,
      })
      .select('id, challenge_id, user_id, username, photo_uri, caption, created_at')
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      source: 'supabase',
      submission: {
        id: data.id,
        challengeId: data.challenge_id,
        userId: data.user_id,
        username: data.username,
        photoUri: data.photo_uri,
        caption: data.caption,
        votes: 0,
        createdAt: data.created_at,
      },
    });
  } catch (error) {
    console.error('[CHALLENGES] submit error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to submit' });
  }
});

/** POST /api/challenges/:id/submissions/:submissionId/vote — vote (one per user). */
router.post('/api/challenges/:id/submissions/:submissionId/vote', async (req, res) => {
  const challengeId = safeString(req.params.id);
  const submissionId = safeString(req.params.submissionId);
  const customer = await authenticateCustomer(req);
  const userId = customer?.userId || '';

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Signed-in identity required' });
  }

  if (!challengeId || !submissionId) {
    return res.status(400).json({ success: false, message: 'challengeId and submissionId required' });
  }

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', voted: false, votes: 0 });
  }

  try {
    const { data: existing } = await supabase
      .from('challenge_votes')
      .select('user_id')
      .eq('submission_id', submissionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      return res.json({ success: false, message: 'already_voted', voted: false, votes: 0 });
    }

    await supabase
      .from('challenge_votes')
      .insert({ challenge_id: challengeId, submission_id: submissionId, user_id: userId });

    const { count } = await supabase
      .from('challenge_votes')
      .select('*', { count: 'exact', head: true })
      .eq('submission_id', submissionId);

    return res.json({
      success: true,
      source: 'supabase',
      voted: true,
      votes: Number(count || 0),
    });
  } catch (error) {
    console.error('[CHALLENGES] vote error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to vote' });
  }
});

/** Finalize a completed challenge. This is admin-only and never rewards submission or voting. */
router.post('/api/admin/challenges/:id/finalize', requireAdmin, async (req, res) => {
  const challengeId = safeString(req.params.id);
  if (!supabaseAdmin) return res.status(503).json({ success: false, message: 'Database unavailable' });
  try {
    const { data: challenge, error: challengeError } = await supabaseAdmin.from('style_challenges')
      .select('id, prize_usd, ends_at, active').eq('id', challengeId).maybeSingle();
    if (challengeError) throw challengeError;
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    if (challenge.active || !challenge.ends_at || new Date(challenge.ends_at).getTime() > Date.now()) {
      return res.status(409).json({ success: false, message: 'Challenge results are not final yet.' });
    }

    const { data: submissions, error: submissionsError } = await supabaseAdmin.from('challenge_submissions')
      .select('id, user_id').eq('challenge_id', challengeId);
    if (submissionsError) throw submissionsError;
    const ranked = [];
    for (const submission of submissions || []) {
      const { count, error } = await supabaseAdmin.from('challenge_votes')
        .select('*', { count: 'exact', head: true }).eq('submission_id', submission.id);
      if (error) throw error;
      ranked.push({ ...submission, votes: Number(count || 0) });
    }
    ranked.sort((a, b) => b.votes - a.votes);
    if (!ranked.length) return res.status(409).json({ success: false, message: 'No eligible submissions.' });
    if (ranked[1] && ranked[1].votes === ranked[0].votes) {
      return res.status(409).json({ success: false, code: 'tie_requires_manual_review', message: 'A tied result requires manual review.' });
    }

    const winner = ranked[0];
    const eventId = `evt_${crypto.randomUUID()}`;
    const grantId = `grant_${crypto.randomUUID()}`;
    const eventKey = `style-challenge:${challengeId}:winner:${winner.id}`;
    const { data: eventRows, error: eventError } = await supabaseAdmin.from('reward_events').upsert({
      event_id: eventId, user_id: winner.user_id, event_type: 'style_challenge_won', source: 'style_challenge_result',
      ruleset_version: 'style-challenge-v1', idempotency_key: eventKey,
      qualifying_metadata: { challengeId, submissionId: winner.id, voteCount: winner.votes },
      verification_source: 'server_finalized_result', occurred_at: new Date().toISOString(),
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('event_id');
    if (eventError) throw eventError;
    const sourceEventId = eventRows?.[0]?.event_id || (await supabaseAdmin.from('reward_events')
      .select('event_id').eq('idempotency_key', eventKey).single()).data?.event_id;
    const amount = Math.max(0, Number(challenge.prize_usd || 0));
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: grantError } = await supabaseAdmin.from('reward_grants').upsert({
      grant_id: grantId, user_id: winner.user_id, source_event_id: sourceEventId,
      source: `style_challenge:${challengeId}`, reward_type: amount > 0 ? 'wallet_credit' : 'unlock',
      amount, currency: amount > 0 ? 'USD' : null, status: 'available', expires_at: expiresAt,
      ruleset_version: 'style-challenge-v1', idempotency_key: `grant:${eventKey}`,
      metadata: { challengeId, submissionId: winner.id },
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    if (grantError) throw grantError;
    fireRewardNotification({ type: 'loyalty-milestone', userId: winner.user_id, amount, relatedId: challengeId }).catch(() => {});
    return res.json({ success: true, replay: !eventRows?.length, winnerSubmissionId: winner.id, grantStatus: 'available' });
  } catch (error) {
    console.error('[CHALLENGES] finalize error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to finalize challenge' });
  }
});

module.exports = { router };
