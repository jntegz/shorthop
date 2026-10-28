// Display names for click sources, shared by the admin and the public share page.

export const SOURCE_LABELS: Record<string, string> = {
  li: "LinkedIn",
  nl: "Newsletter",
  qr: "QR code",
  x: "X / Twitter",
  fb: "Facebook",
  ig: "Instagram",
  yt: "YouTube",
  bsky: "Bluesky",
  threads: "Threads",
  reddit: "Reddit",
  hn: "Hacker News",
  email: "Webmail",
  google: "Google",
  bing: "Bing",
  ddg: "DuckDuckGo",
  site: "Your website",
  referral: "Other websites",
  direct: "Direct / unknown",
};

export function sourceLabel(s: string): string {
  return SOURCE_LABELS[s] ?? s;
}
