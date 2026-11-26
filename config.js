/* =========================================================
 * 云端账号配置（Supabase）
 * 填好下面两项后，应用会自动开启「注册 / 登录」和云端同步。
 * 不填则保持本地模式（单机使用，无需账号，记录存浏览器里）。
 * ========================================================= */
const SUPABASE_URL = "https://fzktptwwnfvqaysyrlga.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_bKx8a3uwyDj811u-5AhEyQ_5aMk9gql";

/* GM 身份由 Supabase「服务端」的 app_metadata.role === "gm" 判定。
 * 这是服务端字段，普通用户改不了（防技术流）。
 * 设置方法：Supabase → SQL Editor 运行
 *   update auth.users
 *   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"gm"}'::jsonb
 *   where email = '你的登录邮箱';
 * 本地模式（未登录）默认就是 GM。 */
