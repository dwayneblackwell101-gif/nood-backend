# COOLX promo asset plan

Export these into `assets/promo/` when the final artwork is ready:

- `coolx-pill.png`
- `coolx-app-icon.png`
- `gift-box.png`
- `cash-card.png`
- `coupon-ticket.png`
- `wallet-icon.png`
- `scissors-icon.png`
- `reward-card-glow.png`
- `arrow-glow.png`
- `confetti.png`
- `thumb-badge.png`
- `wheel-center.png`
- `product-bg-1.png`
- `product-bg-2.png`
- `product-bg-3.png`

Suggested export guidance:

- `coolx-pill.png`
  - 320x112
  - transparent background
  - used in the top brand pill if you replace text branding
  - export at 2x

- `coolx-app-icon.png`
  - 512x512
  - transparent background
  - used in the floating icon step as the featured app badge
  - export at 2x

- `gift-box.png`
  - 600x600
  - transparent background
  - used in promo bubbles or reward reveal art
  - export at 2x

- `cash-card.png`
  - 640x400
  - transparent background
  - used for reward card embellishment
  - export at 2x

- `coupon-ticket.png`
  - 640x360
  - transparent background
  - used in the missed or upgraded ticket scenes
  - export at 2x

- `wallet-icon.png`
  - 512x512
  - transparent background
  - used in floating icons or wallet-themed states
  - export at 2x

- `scissors-icon.png`
  - 512x512
  - transparent background
  - used for coupon-cut visual moments
  - export at 2x

- `reward-card-glow.png`
  - 900x900
  - transparent background
  - used behind the today reward or upgraded reward card
  - export at 2x

- `arrow-glow.png`
  - 420x420
  - transparent background
  - used on intro and upgrade steps for directional energy
  - export at 2x

- `confetti.png`
  - 1200x1200
  - transparent background
  - optional celebratory overlay on reward reveal
  - export at 2x

- `thumb-badge.png`
  - 512x512
  - transparent background
  - used in the credit popup step
  - export at 2x

- `wheel-center.png`
  - 512x512
  - transparent background
  - used in the wheel center badge
  - export at 2x

- `product-bg-1.png`
  - 720x960
  - non-transparent background
  - optional fake product backdrop image
  - export at 2x

- `product-bg-2.png`
  - 720x960
  - non-transparent background
  - optional fake product backdrop image
  - export at 2x

- `product-bg-3.png`
  - 720x960
  - non-transparent background
  - optional fake product backdrop image
  - export at 2x

When the PNGs are ready, replace the `null` values inside `components/promo/assets.ts` with `require('../../assets/promo/<file>.png')`.
