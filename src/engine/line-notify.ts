/**
 * LINE Notify — send alerts to LINE via notify-api.
 */

const LINE_API = "https://notify-api.line.me/api/notify";

export async function sendLineNotify(token: string, message: string): Promise<boolean> {
  if (!token) return false;

  try {
    const res = await fetch(LINE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ message }),
    });

    if (!res.ok) {
      console.error(`[line-notify] ${res.status}: ${await res.text()}`);
      return false;
    }

    console.log("[line-notify] sent");
    return true;
  } catch (e) {
    console.error("[line-notify] failed:", e);
    return false;
  }
}
