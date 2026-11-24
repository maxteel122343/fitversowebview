module.exports = (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    supabase_url: process.env.SUPABASE_URL || null,
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || null,
    preview_mode: process.env.VERCEL === "1" &&
      !process.env.SUPABASE_URL && !process.env.SUPABASE_ANON_KEY,
  });
};
