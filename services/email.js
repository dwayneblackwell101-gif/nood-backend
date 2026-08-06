/**
 * SendGrid email service for NOOD.
 * Handles transactional and marketing emails.
 */

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@noodcaribbean.com';
const FROM_NAME = process.env.FROM_NAME || 'NOOD';

// Lazy-load @sendgrid/mail so the server never crashes if it's not installed.
let sgMail = null;
try {
  sgMail = require('@sendgrid/mail');
  if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
  }
} catch (error) {
  console.warn('[EMAIL] @sendgrid/mail not installed — email sending disabled');
}

const TEMPLATES = {
  // Cart abandonment
  cart_abandonment: {
    subject: 'You left something behind 🛒',
    html: ({ name, items, cartUrl, discountCode, expiresAt }) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #faf7f2;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="background: linear-gradient(135deg, #ff6a00 0%, #ff8a3d 100%); padding: 30px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 28px; font-weight: 900;">You left something behind</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0;">Your cart is waiting</p>
            </div>

            <div style="padding: 30px;">
              <p style="font-size: 16px; color: #333; line-height: 1.6;">Hi ${name || 'there'},</p>
              <p style="font-size: 16px; color: #333; line-height: 1.6;">You were checking out but didn't complete your order. No worries — we saved your cart.</p>

              <div style="background: #faf7f2; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <h3 style="margin: 0 0 16px; color: #4e260d; font-size: 16px;">Your Cart</h3>
                ${items.map(item => `
                  <div style="display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee;">
                    <img src="${item.image}" alt="${item.title}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px;">
                    <div style="margin-left: 12px; flex: 1;">
                      <p style="margin: 0 0 4px; font-weight: 700; color: #333; font-size: 14px;">${item.title}</p>
                      <p style="margin: 0; color: #ff6a00; font-weight: 800; font-size: 14px;">${item.price}</p>
                    </div>
                    <span style="color: #999; font-size: 13px;">Qty: ${item.quantity}</span>
                  </div>
                `).join('')}
              </div>

              ${discountCode ? `
                <div style="background: #fff0e0; border: 2px dashed #ff6a00; border-radius: 12px; padding: 16px; text-align: center; margin: 24px 0;">
                  <p style="margin: 0 0 8px; color: #4e260d; font-weight: 700;">Here's a little help</p>
                  <p style="margin: 0; font-size: 24px; font-weight: 900; color: #ff6a00; letter-spacing: 2px;">${discountCode}</p>
                  <p style="margin: 8px 0 0; color: #8a5a30; font-size: 12px;">15% off your order — expires ${expiresAt}</p>
                </div>
              ` : ''}

              <a href="${cartUrl}" style="display: inline-block; background: linear-gradient(135deg, #ff6a00 0%, #ff8a3d 100%); color: #fff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 900; font-size: 16px; margin: 24px 0;">Complete My Order</a>

              <p style="color: #999; font-size: 13px; text-align: center; margin-top: 32px;">Questions? <a href="mailto:support@noodcaribbean.com" style="color: #ff6a00;">Contact us</a></p>
            </div>

            <div style="background: #faf7f2; padding: 20px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0; color: #999; font-size: 12px;">© ${new Date().getFullYear()} NOOD. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: ({ name, items, cartUrl, discountCode }) => `
Hi ${name || 'there'},

You left some items in your cart. No worries — we saved them for you.

${items.map(item => `- ${item.title} (Qty: ${item.quantity}) - ${item.price}`).join('\n')}

${discountCode ? `Use code ${discountCode} for 15% off (expires soon)` : ''}

Complete your order: ${cartUrl}

Thanks,
Team NOOD
    `,
  },

  // Order confirmation
  order_confirmation: {
    subject: 'Order confirmed — #{order_number}',
    html: ({ name, orderNumber, items, total, trackingUrl, orderUrl }) => `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #faf7f2;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="background: linear-gradient(135deg, #5c31ff 0%, #8a5cff 100%); padding: 30px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 28px; font-weight: 900;">Order Confirmed</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0;">Thank you for your order!</p>
            </div>

            <div style="padding: 30px;">
              <p style="font-size: 16px; color: #333; line-height: 1.6;">Hi ${name || 'there'},</p>
              <p style="font-size: 16px; color: #333; line-height: 1.6;">We've received your order <strong style="color: #5c31ff;">#${orderNumber}</strong> and it's being processed.</p>

              <div style="background: #faf7f2; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <h3 style="margin: 0 0 16px; color: #4e260d; font-size: 16px;">Order Summary</h3>
                ${items.map(item => `
                  <div style="display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee;">
                    <img src="${item.image}" alt="${item.title}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px;">
                    <div style="margin-left: 12px; flex: 1;">
                      <p style="margin: 0 0 4px; font-weight: 700; color: #333; font-size: 14px;">${item.title}</p>
                      <p style="margin: 0; color: #999; font-size: 13px;">Qty: ${item.quantity}</p>
                    </div>
                    <span style="color: #333; font-weight: 700; font-size: 14px;">${item.price}</span>
                  </div>
                `).join('')}
                <div style="display: flex; justify-content: space-between; margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee;">
                  <span style="font-weight: 700; color: #333;">Total</span>
                  <span style="font-weight: 900; color: #5c31ff; font-size: 18px;">${total}</span>
                </div>
              </div>

              <a href="${orderUrl}" style="display: inline-block; background: linear-gradient(135deg, #5c31ff 0%, #8a5cff 100%); color: #fff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 900; font-size: 16px; margin: 24px 0;">View Order Details</a>

              ${trackingUrl ? `
                <a href="${trackingUrl}" style="display: inline-block; background: #fff; border: 2px solid #5c31ff; color: #5c31ff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 800; font-size: 15px; margin-top: 12px;">Track Package</a>
              ` : ''}
            </div>

            <div style="background: #faf7f2; padding: 20px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0; color: #999; font-size: 12px;">© ${new Date().getFullYear()} NOOD. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: ({ name, orderNumber, items, total }) => `
Hi ${name || 'there'},

Your order #${orderNumber} is confirmed!

${items.map(item => `- ${item.title} (Qty: ${item.quantity}) - ${item.price}`).join('\n')}

Total: ${total}

View your order: ${process.env.FRONTEND_URL}/orders/${orderNumber}

Thanks,
Team NOOD
    `,
  },

  // Shipping notification
  shipping_notification: {
    subject: 'Your order is on the way 📦',
    html: ({ name, orderNumber, trackingNumber, trackingUrl, carrier, estimatedDelivery }) => `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #faf7f2;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="background: linear-gradient(135deg, #1a8a5a 0%, #34c759 100%); padding: 30px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 28px; font-weight: 900;">It's on the way! 📦</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0;">Order #${orderNumber} has shipped</p>
            </div>

            <div style="padding: 30px;">
              <p style="font-size: 16px; color: #333; line-height: 1.6;">Hi ${name || 'there'},</p>
              <p style="font-size: 16px; color: #333; line-height: 1.6;">Great news — your order <strong>#${orderNumber}</strong> is on its way to you.</p>

              <div style="background: #f0fdf4; border: 2px solid #1a8a5a; border-radius: 12px; padding: 20px; margin: 24px 0; text-align: center;">
                <p style="margin: 0 0 8px; color: #1a8a5a; font-weight: 700; font-size: 14px;">Tracking Number</p>
                <p style="margin: 0; font-size: 22px; font-weight: 900; color: #1a8a5a; letter-spacing: 2px;">${trackingNumber}</p>
                <p style="margin: 8px 0 0; color: #1a8a5a; font-size: 13px; font-weight: 600;">Carrier: ${carrier}</p>
                ${estimatedDelivery ? `<p style="margin: 8px 0 0; color: #1a8a5a; font-size: 13px;">Estimated delivery: ${estimatedDelivery}</p>` : ''}
              </div>

              <a href="${trackingUrl}" style="display: inline-block; background: linear-gradient(135deg, #1a8a5a 0%, #34c759 100%); color: #fff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 900; font-size: 16px; margin: 24px 0;">Track Package</a>

              <p style="color: #999; font-size: 13px; text-align: center; margin-top: 32px;">Questions? <a href="mailto:support@noodcaribbean.com" style="color: #5c31ff;">Contact us</a></p>
            </div>

            <div style="background: #faf7f2; padding: 20px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0; color: #999; font-size: 12px;">© ${new Date().getFullYear()} NOOD. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: ({ name, orderNumber, trackingNumber, trackingUrl, carrier, estimatedDelivery }) => `
Hi ${name || 'there'},

Your order #${orderNumber} has shipped!

Tracking: ${trackingNumber} (${carrier})
${estimatedDelivery ? `Estimated delivery: ${estimatedDelivery}` : ''}

Track your package: ${trackingUrl}

Thanks,
Team NOOD
    `,
  },

  // Welcome email
  welcome: {
    subject: 'Welcome to NOOD 🎉',
    html: ({ name, referralCode, referralUrl }) => `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #faf7f2;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="background: linear-gradient(135deg, #ff6a00 0%, #ff8a3d 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 32px; font-weight: 900;">Welcome to NOOD! 🎉</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 12px 0 0; font-size: 18px;">Your shopping adventure starts now</p>
            </div>

            <div style="padding: 30px;">
              <p style="font-size: 16px; color: #333; line-height: 1.6;">Hi ${name || 'there'},</p>
              <p style="font-size: 16px; color: #333; line-height: 1.6;">Welcome to NOOD — where shopping meets rewards, games, and a little bit of magic.</p>

              <div style="background: linear-gradient(135deg, #fff0e0 0%, #ffe8d0 100%); border-radius: 16px; padding: 24px; margin: 24px 0; text-align: center; border: 2px solid #ffd166;">
                <p style="margin: 0 0 12px; color: #4e260d; font-weight: 800; font-size: 14px;">Your referral code</p>
                <p style="margin: 0; font-size: 28px; font-weight: 900; color: #ff6a00; letter-spacing: 4px;">${referralCode}</p>
                <p style="margin: 12px 0 0; color: #8a5a30; font-size: 13px;">Share it — you both get $10 when they order</p>
              </div>

              <p style="font-size: 16px; color: #333; line-height: 1.6;">Here's what makes NOOD different:</p>
              <ul style="color: #333; line-height: 2; padding-left: 20px;">
                <li>🎮 <strong>Games that pay</strong> — Spin, scratch, and win real store credit</li>
                <li>📅 <strong>Daily rewards</strong> — Check in daily, earn escalating rewards</li>
                <li>💎 <strong>VIP status</strong> — The more you shop, the better the perks</li>
                <li>📸 <strong>Visual search</strong> — Snap a photo, find the product</li>
                <li>🥽 <strong>AR try-on</strong> — See it on you before you buy</li>
              </ul>

              <a href="https://noodcaribbean.com" style="display: inline-block; background: linear-gradient(135deg, #ff6a00 0%, #ff8a3d 100%); color: #fff; padding: 16px 32px; border-radius: 12px; text-decoration: none; font-weight: 900; font-size: 16px; margin: 24px 0;">Start Shopping</a>

              <p style="color: #999; font-size: 13px; text-align: center; margin-top: 32px;">Questions? <a href="mailto:support@noodcaribbean.com" style="color: #ff6a00;">Contact us</a></p>
            </div>

            <div style="background: #faf7f2; padding: 20px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0; color: #999; font-size: 12px;">© ${new Date().getFullYear()} NOOD. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: ({ name, referralCode }) => `
Hi ${name || 'there'},

Welcome to NOOD! 🎉

Your referral code: ${referralCode}
Share it — you both get $10 when they order.

What makes NOOD different:
- Games that pay real store credit
- Daily rewards for checking in
- VIP status with better perks
- Visual search & AR try-on

Start shopping: https://noodcaribbean.com

Thanks,
Team NOOD
    `,
  },
};

function renderTemplate(templateName, data) {
  const template = TEMPLATES[templateName];
  if (!template) throw new Error(`Template ${templateName} not found`);
  return {
    subject: template.subject.replace(/#\{(\w+)\}/g, (_, key) => data[key] || ''),
    html: template.html(data),
    text: template.text(data),
  };
}

async function sendEmail({ to, templateName, data }) {
  if (!SENDGRID_API_KEY) {
    console.warn('[EMAIL] SendGrid not configured — skipping send');
    return { success: false, reason: 'not_configured' };
  }

  if (!sgMail) {
    console.warn('[EMAIL] @sendgrid/mail not installed — skipping send');
    return { success: false, reason: 'package_missing' };
  }

  try {
    const { subject, html, text } = renderTemplate(templateName, data);

    await sgMail.send({
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      html,
      text,
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true },
      },
    });

    return { success: true };
  } catch (error) {
    console.error('[EMAIL] Send failed:', error.message);
    return { success: false, reason: error.message };
  }
}

module.exports = { sendEmail, TEMPLATES };