/**
 * Common multi-part public suffixes (eTLDs).
 * Enables accurate organizational root domain (eTLD+1) extraction across international
 * and regional email sender domains without requiring a massive multi-megabyte PSL bundle.
 */
const TWO_PART_TLDS = new Set([
  // China
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  // United Kingdom
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "gov.uk", "ac.uk",
  // Japan
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  // Australia
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  // New Zealand
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  // Taiwan
  "com.tw", "org.tw", "idv.tw", "game.tw", "edu.tw",
  // Hong Kong
  "com.hk", "org.hk", "edu.hk", "gov.hk", "net.hk",
  // Singapore
  "com.sg", "org.sg", "edu.sg", "gov.sg", "net.sg",
  // Korea
  "co.kr", "ne.kr", "or.kr", "re.kr", "pe.kr", "go.kr",
  // India
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
  // Brazil
  "com.br", "net.br", "org.br", "adv.br", "blog.br",
  // Mexico
  "com.mx", "org.mx", "net.mx", "edu.mx", "gob.mx",
  // South Africa
  "co.za", "net.za", "org.za", "web.za",
]);

/**
 * Extracts the organizational root domain (eTLD+1) from an email address or host.
 *
 * Examples:
 * - "news@insideapple.apple.com" -> "apple.com"
 * - "order-update@amazon.co.uk"  -> "amazon.co.uk"
 * - "service@notice.aliyun.com"  -> "aliyun.com"
 * - "pay@service.alipay.com"     -> "alipay.com"
 * - "billing@stripe.com"         -> "stripe.com"
 */
export function extractRootDomain(input: string): string {
  if (!input) return "";
  let host = input.trim().toLowerCase();
  const atIndex = host.lastIndexOf("@");
  if (atIndex !== -1) {
    host = host.slice(atIndex + 1);
  }
  // Strip trailing port or dot
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || host.includes("/") || host.includes(" ")) return "";

  const parts = host.split(".");
  if (parts.length <= 2) {
    return host;
  }

  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }

  return parts.slice(-2).join(".");
}
