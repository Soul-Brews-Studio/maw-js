export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Federation-Token, X-From-Signature",
    "Access-Control-Allow-Private-Network": "true",
  };
}

export function handleCorsOptions(req: Request): Response | undefined {
  if (req.method !== "OPTIONS") return undefined;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
