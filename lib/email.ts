import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM   = 'Usealong <notifications@usealong.co>';

async function send(to: string | string[], subject: string, html: string) {
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err: any) {
    // Non-fatal — log and continue, never let email failure break payment flow
    console.error('[email] Failed:', subject, err.message);
  }
}


function template(title: string, body: string, cta?: { label: string; url: string }): string {
  const ctaHtml = cta ? `
    <div style="text-align:center;margin:32px 0;">
      <a href="${cta.url}" style="background:#14A08A;color:#fff;padding:14px 28px;border-radius:100px;
         text-decoration:none;font-weight:500;font-size:15px;display:inline-block;">
        ${cta.label}
      </a>
    </div>` : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;
          overflow:hidden;border:1px solid #e8e8e0;">
          <tr><td style="background:#14A08A;padding:24px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:600;">Usealong</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <h2 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a18;">${title}</h2>
            <div style="font-size:15px;line-height:1.7;color:#5a5a55;">${body}</div>
            ${ctaHtml}
          </td></tr>
          <tr><td style="padding:20px 32px;background:#f5f5f0;border-top:1px solid #e8e8e0;">
            <p style="margin:0;font-size:12px;color:#8a8a85;">
              Usealong — Commute with people you trust.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}


export function sendWelcomeEmail(to: string, name: string, accountType: 'host' | 'rider') {
  const first    = name.split(' ')[0];
  const roleText = accountType === 'host'
    ? 'Set up your schedule and go live to start accepting riders.'
    : 'Browse hosts on your route and subscribe to a daily ride.';
  return send(to, `Welcome to Usealong, ${first}! Your account is verified ✓`,
    template(`You're verified, ${first}!`,
      `<p>Welcome to Usealong. ${roleText}</p>`,
      { label: accountType === 'host' ? 'Go live now' : 'Browse hosts', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}


export function sendRideRequestEmail(params: {
  to: string; hostName: string; riderName: string;
  pickupStop: string; durationMonths: number; totalAmount: number; deadline: string;
}) {
  const { to, hostName, riderName, pickupStop, durationMonths, totalAmount, deadline } = params;
  const first    = hostName.split(' ')[0];
  const months   = `${durationMonths} month${durationMonths !== 1 ? 's' : ''}`;
  const deadline_ = new Date(deadline).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

  return send(to, `${riderName} wants to ride with you`,
    template(`New ride request from ${riderName}`,
      `<p>Hi ${first}, <strong>${riderName}</strong> wants to join your route for <strong>${months}</strong>.</p>
       <p>Pickup: <strong>${pickupStop}</strong> · Total paid: <strong>₦${totalAmount.toLocaleString()}</strong></p>
       <p style="background:#fdf8ec;border-radius:8px;padding:12px 16px;font-size:14px;">
         ⏰ Respond by <strong>${deadline_}</strong> or the request will be auto-cancelled and refunded.
       </p>`,
      { label: 'View request in app', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}


export function sendRequestAcceptedEmail(params: {
  to: string; riderName: string; hostName: string;
  routeLabel: string; pickupStop: string; departureTime: string;
}) {
  const { to, riderName, hostName, routeLabel, pickupStop, departureTime } = params;
  const first = riderName.split(' ')[0];
  return send(to, `🎉 ${hostName} accepted your ride request`,
    template(`You're on the ride, ${first}!`,
      `<p><strong>${hostName}</strong> accepted your request. Your subscription is now active.</p>
       <p>Route: <strong>${routeLabel}</strong><br>
          Pickup: <strong>${pickupStop}</strong><br>
          Departure: <strong>${departureTime}</strong></p>`,
      { label: 'View my ride', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}

export function sendRequestDeclinedEmail(params: {
  to: string; riderName: string; hostName: string; reason: 'declined' | 'expired';
}) {
  const { to, riderName, hostName, reason } = params;
  const first   = riderName.split(' ')[0];
  const because = reason === 'expired'
    ? `${hostName} didn't respond within 48 hours, so your request was automatically cancelled.`
    : `${hostName} was unable to accept your request at this time.`;
  return send(to, `Your ride request was not accepted`,
    template(`Request not accepted, ${first}`,
      `<p>${because}</p>
       <p>Your full payment has been refunded — allow <strong>3–5 business days</strong> to appear.</p>`,
      { label: 'Browse other hosts', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}


export function sendPaymentConfirmationEmail(params: {
  to: string; riderName: string; amount: number; reference: string; hostName: string; durationMonths: number;
}) {
  const { to, riderName, amount, reference, hostName, durationMonths } = params;
  const first  = riderName.split(' ')[0];
  const months = `${durationMonths} month${durationMonths !== 1 ? 's' : ''}`;
  return send(to, `Payment confirmed — ₦${amount.toLocaleString()}`,
    template(`Payment received`,
      `<p>Hi ${first}, we received ₦${amount.toLocaleString()} for your ${months} subscription with <strong>${hostName}</strong>.</p>
       <p style="font-size:13px;color:#8a8a85;">Ref: ${reference}</p>
       <p style="font-size:13px;">Your payment is held securely until ${hostName} accepts your request.</p>`
    )
  );
}


export function sendRefundEmail(params: {
  to: string; riderName: string; amount: number; reference: string; reason: string;
}) {
  const { to, riderName, amount, reference, reason } = params;
  const first = riderName.split(' ')[0];
  return send(to, `Refund processed — ₦${amount.toLocaleString()}`,
    template(`Your refund is on the way`,
      `<p>Hi ${first}, we've refunded <strong>₦${amount.toLocaleString()}</strong> to your card.</p>
       <p style="background:#f5f5f0;border-radius:8px;padding:12px 16px;">Reason: ${reason}</p>
       <p>Allow <strong>3–5 business days</strong> for it to appear on your statement.</p>
       <p style="font-size:13px;color:#8a8a85;">Ref: ${reference}</p>`
    )
  );
}


export function sendEarningsCreditedEmail(params: {
  to: string; hostName: string; amount: number; riderName: string; period: string;
}) {
  const { to, hostName, amount, riderName, period } = params;
  const first = hostName.split(' ')[0];
  return send(to, `₦${amount.toLocaleString()} credited for ${period}`,
    template(`Earnings for ${period}`,
      `<p>Hi ${first}, ₦${amount.toLocaleString()} from <strong>${riderName}</strong> for <strong>${period}</strong> has been credited.</p>`
    )
  );
}


export function sendRenewalReminderEmail(params: {
  to: string; riderName: string; hostName: string; endDate: string;
}) {
  const { to, riderName, hostName, endDate } = params;
  const first = riderName.split(' ')[0];
  const end   = new Date(endDate).toLocaleDateString('en-NG', { dateStyle: 'long' });
  return send(to, `Your Usealong subscription ends on ${end}`,
    template(`Subscription ending soon`,
      `<p>Hi ${first}, your subscription with <strong>${hostName}</strong> ends on <strong>${end}</strong>.</p>
       <p>Your card will be automatically charged to renew. Cancel in the app before ${end} if you don't want to renew.</p>`,
      { label: 'Manage subscription', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}

export function sendSubscriptionCompletedEmail(params: {
  to: string; name: string; role:string; period: string;startDate: string; endDate: string; amount: number;
}) {
  const { to, endDate, name, role, period, startDate, amount } = params;
  const first = name.split(' ')[0];
  const end   = new Date(endDate).toLocaleDateString('en-NG', { dateStyle: 'long' });
  const start   = new Date(startDate).toLocaleDateString('en-NG', { dateStyle: 'long' });

  const intro = role === 'host' ? `<p>Hi ${first}, your subscription for ${period} between ${start} and ${end} has been completed successfully. You've earned ₦${amount.toLocaleString()} from this subscription.</p>` : `<p>Hi ${first}, your subscription for ${period} between ${start} and ${end} has been completed successfully. You've paid ₦${amount.toLocaleString()} for this subscription.</p>`;

  return send(to, `Your Usealong subscription for ${period} has ended`,
    template(`Subscription completed`,
      `<p>${intro}</p>
        <p>${role === 'host' ? `You've earned ₦${amount.toLocaleString()} from this subscription.` : `You've paid ₦${amount.toLocaleString()} for this subscription.`}</p>
        <p>Thank you for being part of the Usealong community.</p>`,
      { label: 'Check Details', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}


export function sendHostOnlineEmail(params: {
  to: string[]; hostName: string; routeLabel: string; monthlyPrice: number;
}) {
  const { to, hostName, routeLabel, monthlyPrice } = params;
  return send(to, `A host on your route just came online`,
    template(`New host available`,
      `<p><strong>${hostName}</strong> is now offering rides on <strong>${routeLabel}</strong> for <strong>₦${monthlyPrice.toLocaleString()}/month</strong>.</p>
       <p style="font-size:13px;">Slots fill up fast — request early.</p>`,
      { label: 'View host', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}


//change content later
export function sendRideCompletedEmail(params: {
  to: string[]; name: string; role: string; date: string; otherName: string;
}) {
  const { to, name, role, date, otherName } = params;
  return send(to, `A host on your route just came online`,
    template(`New host available`,
      `<p><strong>${name}</strong> is now offering rides on <strong>${role}</strong> for <strong>₦${date.toLocaleString()}/month</strong>.</p>
       <p style="font-size:13px;">Slots fill up fast — request early.</p>`,
      { label: 'View host', url: process.env.NEXT_PUBLIC_APP_URL! }
    )
  );
}