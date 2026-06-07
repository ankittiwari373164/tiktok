// db.js — Supabase client
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Test connection on startup
supabase.from("clients").select("id").limit(1)
  .then(({ error }) => {
    if (error) { console.error("✗ Supabase connection failed:", error.message); process.exit(1); }
    else console.log("✓ Supabase connected");
  });

module.exports = { supabase };