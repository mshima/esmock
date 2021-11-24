import fs from 'fs';
import resolvewith from 'resolvewithplus';

import {
  esmockCacheSet,
  esmockCacheResolvedPathGet,
  esmockCacheResolvedPathSet,
  esmockCacheResolvedPathIsESMGet,
  esmockCacheResolvedPathIsESMSet
} from './esmockCache.js';

const esmockModuleApply = (definitionLive, definitionMock, definitionPath) => {
  const isDefaultNamespace = o => typeof o === 'object' && 'default' in o;
  const isCorePath = !/\//.test(definitionPath);
  const definition = isCorePath
    ? Object.assign({ default : definitionMock }, definitionMock)
    : Object.assign({}, definitionLive, definitionMock);
  const isDefaultLive = isDefaultNamespace(definitionLive);
  const isDefaultMock = isDefaultNamespace(definitionMock);
  const isDefault = isDefaultNamespace(definition);

  // no names 'default' or otherwise exported at mock
  const mockNameIsNotExported = Object.keys(definitionMock).length === 0
    && typeof definitionMock !== 'object';

  // live module exports only a 'default' value. mock defines
  // single value that is not 'default'
  const liveExportsDefaultOnly = Object.keys(definitionLive).length === 1
    && isDefaultLive && !isDefaultMock;

  if (mockNameIsNotExported || liveExportsDefaultOnly) {
    if (isDefault) {
      // is nested default, sometimes generated by babel
      if (isDefaultNamespace(definition.default)) {
        definition.default = definitionMock;
        definition.default.default = definitionMock;
      } else {
        definition.default = definitionMock;
      }
    }
  }

  return definition;
};

// eslint-disable-next-line max-len
const esmockModuleESMRe = /(^\s*|[}\);\n]\s*)(import\s+(['"]|(\*\s+as\s+)?[^"'\(\)\n;]+\s+from\s+['"]|\{)|export\s+\*\s+from\s+["']|export\s+(\{|default|function|class|var|const|let|async\s+function))/;

// tries to return resolved value from a cache first
// else, builds value, stores in cache and returns
const esmockModuleIsESM = (mockPathFull, isesm) => {
  isesm = esmockCacheResolvedPathIsESMGet(mockPathFull);

  console.log({
    mockPathFull,
    isesm
  });
  if (typeof isesm === 'boolean')
    return isesm;

  isesm = /^\//.test(mockPathFull)
    && esmockModuleESMRe.test(fs.readFileSync(mockPathFull, 'utf-8'));

  esmockCacheResolvedPathIsESMSet(mockPathFull, isesm);

  return isesm;
};

// return the default value directly, so that the esmock caller
// does not need to lookup default as in "esmockedValue.default"
const esmockModuleImportedSanitize = importedModule => {
  const importedDefault = 'default' in importedModule
        && importedModule.default;
  
  if (!/boolean|string|number/.test(typeof importedDefault)) {
    // an example of [object Module]: import * as mod from 'fs'; export mod;
    return Object.prototype.toString.call(importedDefault) === '[object Module]'
      ? Object.assign({}, importedDefault, importedModule)
      : Object.assign(importedDefault, importedModule);
  }

  return importedModule;
};

const esmockModuleImportedPurge = modulePathKey => {
  const purgeKey = key => esmockCacheSet(key, null);
  const [ url, keys ] = modulePathKey.split('#esmockModuleKeys=');

  String(keys).split('#').forEach(purgeKey);
  String(url.split('esmockGlobals=')[1]).split('#').forEach(purgeKey);
};

const esmockNextKey = ((key = 0) => () => ++key)();

// tries to return resolved path from a cache store first
// else, builds resolved path, stores in cache and returns
const esmockCacheResolvedPathGetCreate = (calleePath, modulePath) => (
  console.log({
    modulePath,
    calleePath,
    resolved : resolvewith(
      modulePath, calleePath === '///D' ? '///D:' : calleePath, { esm : true })
  }),
  esmockCacheResolvedPathGet(calleePath, modulePath)
    || esmockCacheResolvedPathSet(
      calleePath,
      modulePath,
      resolvewith(modulePath, calleePath, { esm : true }))
);

const esmockModuleCreate = async (esmockKey, key, mockPathFull, mockDef) => {
  const isesm = esmockModuleIsESM(mockPathFull);
  const isCorePath = !/\//.test(mockPathFull);
  const mockDefinitionFinal = esmockModuleApply(
    await import(mockPathFull), mockDef, mockPathFull);

  const mockModuleProtocol = isCorePath ? 'node:' : 'file://';
  const mockModuleKey = `${mockModuleProtocol}${mockPathFull}?` + [
    'esmockKey=' + esmockKey,
    'esmockModuleKey=' + key,
    'isesm=' + isesm,
    'exportNames=' + Object.keys(mockDefinitionFinal).sort().join()
  ].join('&');

  esmockCacheSet(mockModuleKey, mockDefinitionFinal);

  return mockModuleKey;
};

// eslint-disable-next-line max-len
const esmockModulesCreate = async (pathCallee, pathModule, esmockKey, defs, keys, mocks) => {
  keys = keys || Object.keys(defs);
  mocks = mocks || [];

  if (!keys.length)
    return mocks;

  const mockedPathFull = esmockCacheResolvedPathGetCreate(pathCallee, keys[0]);
  if (!mockedPathFull) {
    pathCallee = pathCallee
      .replace(/^\/\//, '')
      .replace(process.cwd(), '.')
      .replace(process.env.HOME, '~');
    throw new Error(`not a valid path: "${keys[0]}" (used by ${pathCallee})`);
  }

  mocks.push(await esmockModuleCreate(
    esmockKey,
    keys[0],
    mockedPathFull,
    defs[keys[0]]
  ));

  return esmockModulesCreate(
    pathCallee, pathModule, esmockKey, defs, keys.slice(1), mocks);
};

const esmockModuleMock = async (calleePath, modulePath, defs, gdefs, opt) => {
  const pathModuleFull = esmockCacheResolvedPathGetCreate(
    calleePath, modulePath);
  const esmockKey = typeof opt.key === 'number' ? opt.key : esmockNextKey();
  const esmockModuleKeys = await esmockModulesCreate(
    calleePath, pathModuleFull, esmockKey, defs, Object.keys(defs));
  const esmockGlobalKeys = await esmockModulesCreate(
    calleePath, pathModuleFull, esmockKey, gdefs, Object.keys(gdefs));

  if (pathModuleFull === null) {
    throw new Error(`modulePath not found: "${modulePath}"`);
  }
    
  const esmockCacheKey = `file://${pathModuleFull}?`
    + 'key=:esmockKey?esmockGlobals=:esmockGlobals#esmockModuleKeys=:moduleKeys'
      .replace(/:esmockKey/, esmockKey)
      .replace(/:esmockGlobals/, esmockGlobalKeys.join('#') || 'null')
      .replace(/:moduleKeys/, esmockModuleKeys.join('#'));

  return esmockCacheKey;
};

export {
  esmockModuleMock,
  esmockModuleImportedPurge,
  esmockModuleImportedSanitize
};
