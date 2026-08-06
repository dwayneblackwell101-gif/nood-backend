/**
 * Video feed engagement API.
 *
 * Real likes, comments, and shares for the shoppable video feed, stored in
 * Supabase. The app calls these endpoints so counts are shared across all
 * users (not just per-device).
 *
 * Requires Supabase tables:
 *   video_engagement (video_id text PK, likes int, shares int)
 *   video_comments   (id uuid PK default gen_random_uuid(), video_id text,
 *                     user_id text, author text, body text, created_at timestamptz)
 *   video_likes      (video_id text, user_id text, PK (video_id, user_id))
 */

const express = require('express');
const { supabase } = require('../utils/supabase');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** GET /api/video-feed/:id — fetch like/share counts + comments for a video. */
router.get('/api/video-feed/:id', async (req, res) => {
  const videoId = safeString(req.params.id);
  if (!videoId) {
    return res.status(400).json({ success: false, message: 'videoId is required' });
  }

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', videoId, likes: 0, shares: 0, comments: [] });
  }

  try {
    const [{ data: engagement }, { data: comments }] = await Promise.all([
      supabase.from('video_engagement').select('likes, shares').eq('video_id', videoId).maybeSingle(),
      supabase
        .from('video_comments')
        .select('id, author, body, created_at')
        .eq('video_id', videoId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    return res.json({
      success: true,
      source: 'supabase',
      videoId,
      likes: Number(engagement?.likes || 0),
      shares: Number(engagement?.shares || 0),
      comments: (comments || []).map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.created_at,
      })),
    });
  } catch (error) {
    console.error('[VIDEO FEED] fetch error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch engagement' });
  }
});

/** POST /api/video-feed/:id/like — toggle like for a user. */
router.post('/api/video-feed/:id/like', async (req, res) => {
  const videoId = safeString(req.params.id);
  const userId = safeString(req.body?.userId, 'guest');
  if (!videoId) {
    return res.status(400).json({ success: false, message: 'videoId is required' });
  }

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', liked: false, likes: 0 });
  }

  try {
    // Check if already liked by this user.
    const { data: existing } = await supabase
      .from('video_likes')
      .select('video_id')
      .eq('video_id', videoId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // Unlike.
      await supabase.from('video_likes').delete().eq('video_id', videoId).eq('user_id', userId);
      await decrementLikes(videoId);
    } else {
      // Like.
      await supabase.from('video_likes').insert({ video_id: videoId, user_id: userId });
      await incrementLikes(videoId);
    }

    const { data: engagement } = await supabase
      .from('video_engagement')
      .select('likes')
      .eq('video_id', videoId)
      .maybeSingle();

    return res.json({
      success: true,
      source: 'supabase',
      videoId,
      liked: !existing,
      likes: Number(engagement?.likes || 0),
    });
  } catch (error) {
    console.error('[VIDEO FEED] like error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to toggle like' });
  }
});

/** POST /api/video-feed/:id/comment — add a comment. */
router.post('/api/video-feed/:id/comment', async (req, res) => {
  const videoId = safeString(req.params.id);
  const body = safeString(req.body?.body);
  const author = safeString(req.body?.author, 'noodshop');
  const userId = safeString(req.body?.userId, 'guest');

  if (!videoId || !body) {
    return res.status(400).json({ success: false, message: 'videoId and body are required' });
  }
  if (body.length > 500) {
    return res.status(400).json({ success: false, message: 'Comment too long (max 500 chars)' });
  }

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', comment: null });
  }

  try {
    const { data, error } = await supabase
      .from('video_comments')
      .insert({ video_id: videoId, user_id: userId, author, body })
      .select('id, author, body, created_at')
      .single();

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      source: 'supabase',
      comment: {
        id: data.id,
        author: data.author,
        body: data.body,
        createdAt: data.created_at,
      },
    });
  } catch (error) {
    console.error('[VIDEO FEED] comment error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to add comment' });
  }
});

/** POST /api/video-feed/:id/share — record a share (increments counter). */
router.post('/api/video-feed/:id/share', async (req, res) => {
  const videoId = safeString(req.params.id);
  if (!videoId) {
    return res.status(400).json({ success: false, message: 'videoId is required' });
  }

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', shares: 0 });
  }

  try {
    await incrementShares(videoId);
    const { data: engagement } = await supabase
      .from('video_engagement')
      .select('shares')
      .eq('video_id', videoId)
      .maybeSingle();

    return res.json({
      success: true,
      source: 'supabase',
      videoId,
      shares: Number(engagement?.shares || 0),
    });
  } catch (error) {
    console.error('[VIDEO FEED] share error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to record share' });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Atomic increment of a numeric column. Supabase JS doesn't support
 * `UPDATE ... SET col = col + 1` natively, so we use a Postgres RPC
 * function (recommended, atomic) with a read-modify-write fallback.
 *
 * Recommended RPC functions to create in Supabase:
 *   create function increment_engagement(video_id text, col text, delta int)
 *   ... see SCHEMA.md for full SQL
 */
async function incrementColumn(videoId, column, delta) {
  // Ensure the row exists first.
  await supabase
    .from('video_engagement')
    .upsert({ video_id: videoId, likes: 0, shares: 0 }, { onConflict: 'video_id' });

  // Try the atomic RPC if available.
  const { error } = await supabase.rpc('increment_engagement', {
    video_id: videoId,
    col: column,
    delta,
  });

  if (error) {
    // Fallback: read-modify-write.
    const { data } = await supabase
      .from('video_engagement')
      .select(column)
      .eq('video_id', videoId)
      .maybeSingle();
    const current = Number(data?.[column] || 0);
    await supabase
      .from('video_engagement')
      .update({ [column]: Math.max(0, current + delta) })
      .eq('video_id', videoId);
  }
}

async function incrementLikes(videoId) {
  await incrementColumn(videoId, 'likes', 1);
}

async function decrementLikes(videoId) {
  await incrementColumn(videoId, 'likes', -1);
}

async function incrementShares(videoId) {
  await incrementColumn(videoId, 'shares', 1);
}

module.exports = { router };