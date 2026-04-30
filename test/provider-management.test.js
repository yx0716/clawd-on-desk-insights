/**
 * Unit tests for provider management functions
 * Tests: generateUUID, validateProvider, and provider registry CRUD operations
 */

const assert = require('assert');
const test = require('node:test');

// Mock context for testing
function createMockContext() {
  let config = null;
  
  return {
    getAIConfig: () => config,
    setAIConfig: (cfg) => { config = cfg; },
    analysisCachePath: '/tmp/test-cache.json',
  };
}

// Import the analytics-ai module
const initAnalyticsAI = require('../src/analytics-ai');

test('Provider Management - generateUUID()', async (t) => {
  const ctx = createMockContext();
  const analytics = initAnalyticsAI(ctx);

  await t.test('should generate a valid UUID v4 format', () => {
    const uuid = analytics.generateUUID();
    
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert(uuidRegex.test(uuid), `Generated UUID "${uuid}" does not match v4 format`);
  });

  await t.test('should generate unique UUIDs', () => {
    const uuid1 = analytics.generateUUID();
    const uuid2 = analytics.generateUUID();
    const uuid3 = analytics.generateUUID();
    
    assert.notStrictEqual(uuid1, uuid2, 'Generated UUIDs should be unique');
    assert.notStrictEqual(uuid2, uuid3, 'Generated UUIDs should be unique');
    assert.notStrictEqual(uuid1, uuid3, 'Generated UUIDs should be unique');
  });
});

test('Provider Management - validateProvider()', async (t) => {
  const ctx = createMockContext();
  const analytics = initAnalyticsAI(ctx);

  await t.test('should accept a valid provider', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
    };
    
    assert.doesNotThrow(() => {
      analytics.validateProvider(provider);
    }, 'Valid provider should not throw');
  });

  await t.test('should reject provider without name', () => {
    const provider = {
      type: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /name is required/, 'Should reject provider without name');
  });

  await t.test('should reject provider with empty name', () => {
    const provider = {
      name: '   ',
      type: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /name is required/, 'Should reject provider with empty name');
  });

  await t.test('should reject provider with invalid type', () => {
    const provider = {
      name: 'Test Provider',
      type: 'invalid-type',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /type must be one of/, 'Should reject invalid provider type');
  });

  await t.test('should reject provider without baseUrl', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /baseUrl is required/, 'Should reject provider without baseUrl');
  });

  await t.test('should reject provider with invalid URL', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'not-a-valid-url',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /valid URL/, 'Should reject provider with invalid URL');
  });

  await t.test('should reject non-ollama provider without apiKey', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://api.example.com',
      model: 'gpt-4o-mini',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /apiKey/, 'Should reject non-ollama provider without apiKey');
  });

  await t.test('should accept ollama provider without apiKey', () => {
    const provider = {
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama2',
    };
    
    assert.doesNotThrow(() => {
      analytics.validateProvider(provider);
    }, 'Ollama provider should not require apiKey');
  });

  await t.test('should reject provider without model', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /model is required/, 'Should reject provider without model');
  });

  await t.test('should accept provider with customHeaders', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
      customHeaders: { 'X-Custom': 'value' },
    };
    
    assert.doesNotThrow(() => {
      analytics.validateProvider(provider);
    }, 'Provider with customHeaders should be valid');
  });

  await t.test('should reject provider with invalid customHeaders', () => {
    const provider = {
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key',
      model: 'gpt-4o-mini',
      customHeaders: 'not-an-object',
    };
    
    assert.throws(() => {
      analytics.validateProvider(provider);
    }, /customHeaders must be an object/, 'Should reject invalid customHeaders');
  });
});

test('Provider Management - Provider Registry CRUD', async (t) => {
  const ctx = createMockContext();
  const analytics = initAnalyticsAI(ctx);

  await t.test('should get empty registry initially', () => {
    const registry = analytics.getProviderRegistry();
    assert.strictEqual(registry.length, 0, 'Registry should be empty initially');
  });

  await t.test('should add a provider', () => {
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics.addProvider(provider);
    
    assert(added.id, 'Added provider should have an id');
    assert.strictEqual(added.name, provider.name);
    assert.strictEqual(added.type, provider.type);
    assert.strictEqual(added.enabled, true, 'Provider should be enabled by default');
    assert(added.createdAt, 'Provider should have createdAt timestamp');
    assert(added.updatedAt, 'Provider should have updatedAt timestamp');
    
    const registry = analytics.getProviderRegistry();
    assert.strictEqual(registry.length, 1, 'Registry should contain one provider');
  });

  await t.test('should reject duplicate provider names', () => {
    const ctx2 = createMockContext();
    const analytics2 = initAnalyticsAI(ctx2);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    analytics2.addProvider(provider);
    
    assert.throws(() => {
      analytics2.addProvider(provider);
    }, /already exists/, 'Should reject duplicate provider names');
  });

  await t.test('should get a provider by id', () => {
    const ctx3 = createMockContext();
    const analytics3 = initAnalyticsAI(ctx3);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics3.addProvider(provider);
    const retrieved = analytics3.getProvider(added.id);
    
    assert(retrieved, 'Should retrieve provider by id');
    assert.strictEqual(retrieved.id, added.id);
    assert.strictEqual(retrieved.name, provider.name);
  });

  await t.test('should return null for non-existent provider', () => {
    const ctx4 = createMockContext();
    const analytics4 = initAnalyticsAI(ctx4);
    
    const retrieved = analytics4.getProvider('non-existent-id');
    assert.strictEqual(retrieved, null, 'Should return null for non-existent provider');
  });

  await t.test('should update a provider', () => {
    const ctx5 = createMockContext();
    const analytics5 = initAnalyticsAI(ctx5);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics5.addProvider(provider);
    const updated = analytics5.updateProvider(added.id, {
      model: 'glm-4-plus',
      apiKey: 'sk-new-key',
    });
    
    assert.strictEqual(updated.model, 'glm-4-plus');
    assert.strictEqual(updated.apiKey, 'sk-new-key');
    assert.strictEqual(updated.name, provider.name, 'Other fields should remain unchanged');
    assert.strictEqual(updated.id, added.id, 'ID should not change');
    assert.strictEqual(updated.createdAt, added.createdAt, 'createdAt should not change');
    assert(updated.updatedAt >= added.updatedAt, 'updatedAt should be updated');
  });

  await t.test('should delete a provider', () => {
    const ctx6 = createMockContext();
    const analytics6 = initAnalyticsAI(ctx6);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics6.addProvider(provider);
    analytics6.deleteProvider(added.id);
    
    const registry = analytics6.getProviderRegistry();
    assert.strictEqual(registry.length, 0, 'Registry should be empty after deletion');
    
    const retrieved = analytics6.getProvider(added.id);
    assert.strictEqual(retrieved, null, 'Deleted provider should not be retrievable');
  });

  await t.test('should clean up default provider references on delete', () => {
    const ctx7 = createMockContext();
    const analytics7 = initAnalyticsAI(ctx7);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics7.addProvider(provider);
    analytics7.setDefaultProvider('brief', added.id);
    analytics7.setDefaultProvider('detail', added.id);
    
    analytics7.deleteProvider(added.id);
    
    const briefDefault = analytics7.getDefaultProvider('brief');
    const detailDefault = analytics7.getDefaultProvider('detail');
    
    assert.strictEqual(briefDefault, null, 'Default brief provider should be cleared');
    assert.strictEqual(detailDefault, null, 'Default detail provider should be cleared');
  });
});

test('Provider Management - Default Provider Management', async (t) => {
  await t.test('should set and get default provider', () => {
    const ctx = createMockContext();
    const analytics = initAnalyticsAI(ctx);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics.addProvider(provider);
    analytics.setDefaultProvider('brief', added.id);
    
    const defaultId = analytics.getDefaultProvider('brief');
    assert.strictEqual(defaultId, added.id, 'Should return set default provider');
  });

  await t.test('should return null for unset default provider', () => {
    const ctx = createMockContext();
    const analytics = initAnalyticsAI(ctx);
    
    const defaultId = analytics.getDefaultProvider('brief');
    assert.strictEqual(defaultId, null, 'Should return null for unset default provider');
  });

  await t.test('should reject invalid analysis mode', () => {
    const ctx = createMockContext();
    const analytics = initAnalyticsAI(ctx);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics.addProvider(provider);
    
    assert.throws(() => {
      analytics.setDefaultProvider('invalid-mode', added.id);
    }, /Invalid analysis mode/, 'Should reject invalid analysis mode');
  });

  await t.test('should support all analysis modes', () => {
    const ctx = createMockContext();
    const analytics = initAnalyticsAI(ctx);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics.addProvider(provider);
    
    for (const mode of ['brief', 'detail', 'batch']) {
      analytics.setDefaultProvider(mode, added.id);
      const defaultId = analytics.getDefaultProvider(mode);
      assert.strictEqual(defaultId, added.id, `Should support ${mode} mode`);
    }
  });
});

test('Provider Management - Provider Persistence', async (t) => {
  await t.test('should persist providers across instances', () => {
    const ctx = createMockContext();
    const analytics = initAnalyticsAI(ctx);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics.addProvider(provider);
    
    // Create new instance with same context
    const analytics2 = initAnalyticsAI(ctx);
    const registry = analytics2.getProviderRegistry();
    
    assert.strictEqual(registry.length, 1, 'Provider should persist');
    assert.strictEqual(registry[0].id, added.id);
    assert.strictEqual(registry[0].name, provider.name);
  });

  await t.test('should persist default provider settings', () => {
    const ctx = createMockContext();
    const analytics = initAnalyticsAI(ctx);
    
    const provider = {
      name: 'Zhipu AI',
      type: 'openai',
      baseUrl: 'https://api.zhipuai.com',
      apiKey: 'sk-zhipu-key',
      model: 'glm-4-flash',
    };
    
    const added = analytics.addProvider(provider);
    analytics.setDefaultProvider('brief', added.id);
    
    // Create new instance with same context
    const analytics2 = initAnalyticsAI(ctx);
    const defaultId = analytics2.getDefaultProvider('brief');
    
    assert.strictEqual(defaultId, added.id, 'Default provider should persist');
  });
});
