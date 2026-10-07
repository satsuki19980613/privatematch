-- 勝者の演出 GIF（PRIVATE MATCH だけ。既存のマイグレーションは書き換えない）
--   rooms.fx: 席ごとの KLIPY の slug か null の配列（members と同じ順。FREE MATCH は全員 null）。開始時にエンジンの状態（state.fx）へ写し、
--   ブラウザへは views（state.fx）で渡す。書き込みは Neon Function "game"（op create / join / leave / stay / rematch）だけ
alter table public.rooms add column fx jsonb;
