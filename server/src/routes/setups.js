import { Router } from 'express';
import { queryRows, queryOne } from '../db.js';
import { PRAC } from '../config.js';

export const setupsRouter = Router();

/** 设置库（开仓形态定义） */
setupsRouter.get('/', async (req, res) => {
  try {
    const rows = await queryRows(
      `SELECT id, name, description, market_condition, entry_rules, exit_rules, color, enabled, created_at
         FROM ${PRAC.schema}.setups ORDER BY enabled DESC, id`,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        marketCondition: r.market_condition,
        entryRules: r.entry_rules ?? [],
        exitRules: r.exit_rules ?? [],
        color: r.color,
        enabled: r.enabled,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

setupsRouter.post('/', async (req, res) => {
  try {
    const { name, description = '', marketCondition = '', entryRules = [], exitRules = [], color = '#5470c6' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: '缺少 name' });
    const row = await queryOne(
      `INSERT INTO ${PRAC.schema}.setups (name, description, market_condition, entry_rules, exit_rules, color)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       RETURNING id, name, description, market_condition, entry_rules, exit_rules, color, enabled`,
      [String(name).trim(), description, marketCondition, JSON.stringify(entryRules), JSON.stringify(exitRules), color],
    );
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

setupsRouter.patch('/:id', async (req, res) => {
  try {
    const { name, description, marketCondition, entryRules, exitRules, color, enabled } = req.body || {};
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.setups SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         market_condition = COALESCE($4, market_condition),
         entry_rules = COALESCE($5::jsonb, entry_rules),
         exit_rules = COALESCE($6::jsonb, exit_rules),
         color = COALESCE($7, color),
         enabled = COALESCE($8, enabled)
       WHERE id = $1
       RETURNING id, name, description, market_condition, entry_rules, exit_rules, color, enabled`,
      [
        req.params.id,
        name ?? null,
        description ?? null,
        marketCondition ?? null,
        entryRules ? JSON.stringify(entryRules) : null,
        exitRules ? JSON.stringify(exitRules) : null,
        color ?? null,
        enabled ?? null,
      ],
    );
    if (!row) return res.status(404).json({ error: 'setup 不存在' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
