import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers';

describe('GET /health', () => {
  it('reports the API and database as up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });
});
