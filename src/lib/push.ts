import webpush from "web-push";
import { config, supportEmail } from "../config.ts";

export type PushPayload = { title: string; body: string; url: string; tag?: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export function pushEnabled(): boolean {
  return config.VAPID_PUBLIC_KEY !== undefined && config.VAPID_PRIVATE_KEY !== undefined;
}

/** "gone" means the push service dropped this subscription for good: forget it. */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<"sent" | "gone"> {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return "sent";
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        TTL: 3600,
        vapidDetails: {
          subject: config.VAPID_SUBJECT ?? `mailto:${supportEmail}`,
          publicKey: config.VAPID_PUBLIC_KEY,
          privateKey: config.VAPID_PRIVATE_KEY,
        },
      },
    );
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "gone";
    throw err;
  }
}
