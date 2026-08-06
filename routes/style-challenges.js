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
const { supabase } = require('../utils/supabase');

const router = express.Router();

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
  const userId = safeString(req.body?.userId, 'guest');
  const username = safeString(req.body?.username, 'nood_user');
  const photoUri = safeString(req.body?.photoUri);
  const caption = safeString(req.body?.caption, '');

  if (!challengeId || !photoUri) {
    return res.status(400).json({ success: false, message: 'challengeId and photoUri are required' });
  }

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
  const userId = safeString(req.body?.userId, 'guest');

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

module.exports = { router };