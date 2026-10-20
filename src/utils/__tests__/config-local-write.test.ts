/**
 * Local config write-safety tests
 *
 * Every write to <cwd>/.codemie/codemie-cli.config.json must keep keys it does
 * not change, and must refuse (never overwrite) files it cannot understand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '../config.js';
import { ConfigurationError } from '../errors.js';
import { StorageScope, type MultiProviderConfig } from '../../env/types.js';
import * as paths from '../paths.js';

const TEST_DIR = path.join(process.cwd(), 'tmp-test-local-write');
const GLOBAL_CONFIG_DIR = path.join(TEST_DIR, '.codemie');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, 'codemie-cli.config.json');
const WORKING_DIR = path.join(TEST_DIR, 'project');
const LOCAL_CONFIG_PATH = path.join(WORKING_DIR, '.codemie', 'codemie-cli.config.json');

const GLOBAL_CONFIG: MultiProviderConfig = {
  version: 2,
  activeProfile: 'work',
  profiles: {
    work: { provider: 'litellm', baseUrl: 'http://localhost:4000', model: 'gpt' },
    personal: { provider: 'litellm', baseUrl: 'http://localhost:4001', model: 'claude' }
  }
};

async function writeGlobal(config: unknown): Promise<void> {
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function writeLocalRaw(content: string): Promise<void> {
  await fs.writeFile(LOCAL_CONFIG_PATH, content);
}

async function writeLocal(config: unknown): Promise<void> {
  await writeLocalRaw(JSON.stringify(config, null, 2));
}

async function readLocal(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));
}

describe('ConfigLoader local config writes', () => {
  beforeEach(async () => {
    await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_CONFIG_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(GLOBAL_CONFIG_DIR, subpath));
    delete process.env.CODEMIE_DEBUG;
    delete process.env.CODEMIE_PROVIDER;
    delete process.env.CODEMIE_MODEL;
    delete process.env.CODEMIE_BASE_URL;
    delete process.env.CODEMIE_API_KEY;
    await writeGlobal(GLOBAL_CONFIG);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('updateLocalConfig', () => {
    it('keeps every other key of a valid v2 file', async () => {
      const original = {
        version: 2,
        activeProfile: 'a',
        profiles: { a: { provider: 'sso' } },
        codemieAssistants: [{ slug: 'jira' }],
        codemieSkills: [{ slug: 's' }],
        workspace: { codeMieProject: 'philips' },
        custom: 1
      };
      await writeLocal(original);

      await ConfigLoader.updateLocalConfig(WORKING_DIR, config => {
        config.activeProfile = 'b';
      });

      expect(await readLocal()).toEqual({ ...original, activeProfile: 'b' });
    });

    it('fills a versionless assistants/workspace-only file', async () => {
      await writeLocal({ codemieAssistants: [{ slug: 'jira' }], workspace: { codeMieProject: 'philips' } });

      await ConfigLoader.updateLocalConfig(WORKING_DIR, config => {
        config.activeProfile = 'work';
      });

      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'work',
        profiles: {},
        codemieAssistants: [{ slug: 'jira' }],
        workspace: { codeMieProject: 'philips' }
      });
    });

    it('accepts a BOM + CRLF file', async () => {
      const config = { version: 2, activeProfile: 'a', profiles: { a: { provider: 'sso' } }, custom: true };
      await writeLocalRaw(String.fromCharCode(0xfeff) + JSON.stringify(config, null, 2).replace(/\n/g, '\r\n'));

      await ConfigLoader.updateLocalConfig(WORKING_DIR, c => {
        c.activeProfile = 'work';
      });

      expect(await readLocal()).toEqual({ ...config, activeProfile: 'work' });
    });

    it.each([
      ['unparseable JSON', '{not json'],
      ['a non-object', '[]'],
      ['a legacy v1 config', JSON.stringify({ provider: 'openai', model: 'gpt' })],
      ['an unknown version', JSON.stringify({ version: 3, profiles: {} })],
      ['profiles as an array', JSON.stringify({ version: 2, profiles: [], activeProfile: '' })],
      ['a null profile entry', JSON.stringify({ version: 2, profiles: { a: null }, activeProfile: '' })],
      ['a non-string activeProfile', JSON.stringify({ version: 2, profiles: {}, activeProfile: 5 })]
    ])('refuses %s and leaves the file byte-identical', async (_label, content) => {
      await writeLocalRaw(content);

      const update = ConfigLoader.updateLocalConfig(WORKING_DIR, c => {
        c.activeProfile = 'work';
      });

      await expect(update).rejects.toThrow(ConfigurationError);
      await expect(update).rejects.toThrow(LOCAL_CONFIG_PATH);
      await expect(update).rejects.toThrow('left unchanged');
      expect(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8')).toBe(content);
    });

    it('creates a missing file with activeProfile ""', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      await ConfigLoader.updateLocalConfig(WORKING_DIR, c => {
        c.codemieSkills = [];
      });

      expect(await readLocal()).toEqual({ version: 2, activeProfile: '', profiles: {}, codemieSkills: [] });
    });

    it('local skill registration in a fresh dir does not select a profile', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      await ConfigLoader.saveSkillsToProjectConfig(WORKING_DIR, StorageScope.LOCAL, []);

      expect((await readLocal()).activeProfile).toBe('');
      expect(await ConfigLoader.getActiveProfileName(WORKING_DIR)).toBe('work');
    });
  });
});
