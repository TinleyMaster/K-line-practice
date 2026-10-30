import { Router } from 'express';
import { runBacktest, runOptimization } from '../services/backtestService.js';

export const backtestRouter = Router();

backtestRouter.post('/run', async (req, res) => {
  try {
    const result = await runBacktest(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

backtestRouter.post('/optimize', async (req, res) => {
  try {
    const { baseParams = {}, grid = {} } = req.body || {};
    const result = await runOptimization(baseParams, grid);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
