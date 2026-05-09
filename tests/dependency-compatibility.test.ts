// tests/dependency-compatibility.test.ts
// Tests for the dependency compatibility guard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInstallCompatibility,
  checkPackageNames,
  getSafeVersion,
  listRiskyPackages,
} from '../lib/agent/dependency-compatibility.js';

describe('checkInstallCompatibility', () => {
  test('flags Prisma 7 as critical', () => {
    const result = checkInstallCompatibility('npm install prisma@7.0.0 @prisma/client@7.0.0');
    assert.equal(result.hasRisks, true);
    const prismaRisk = result.risks.find(r => r.packageName === 'prisma');
    assert.ok(prismaRisk);
    assert.equal(prismaRisk.riskLevel, 'critical');
    assert.ok(result.guidance.includes('prisma'));
  });

  test('flags Tailwind v4 as critical', () => {
    const result = checkInstallCompatibility('npm install tailwindcss@4.0.0');
    assert.equal(result.hasRisks, true);
    assert.ok(result.risks.some(r => r.riskLevel === 'critical' && r.packageName === 'tailwindcss'));
  });

  test('flags Next.js 15 as high risk', () => {
    const result = checkInstallCompatibility('npm install next@15.0.0');
    assert.equal(result.hasRisks, true);
    assert.ok(result.risks.some(r => r.packageName === 'next' && r.riskLevel === 'high'));
  });

  test('safe versions do not trigger', () => {
    const result = checkInstallCompatibility('npm install prisma@6.0.0');
    assert.equal(result.hasRisks, false);
  });

  test('latest spec triggers risk for critical packages', () => {
    const result = checkInstallCompatibility('npm install tailwindcss@latest');
    assert.equal(result.hasRisks, true);
  });

  test('unknown packages are not flagged', () => {
    const result = checkInstallCompatibility('npm install express@5.0.0');
    assert.equal(result.hasRisks, false);
  });

  test('returns search queries for flagged packages', () => {
    const result = checkInstallCompatibility('npm install prisma@7.0.0');
    assert.ok(result.searchQueries.length > 0);
    assert.ok(result.searchQueries[0].toLowerCase().includes('prisma'));
  });

  test('pnpm add syntax is parsed', () => {
    const result = checkInstallCompatibility('pnpm add zod@4.0.0');
    assert.equal(result.hasRisks, true);
    assert.ok(result.risks.some(r => r.packageName === 'zod'));
  });
});

describe('checkPackageNames', () => {
  test('flags risky package names', () => {
    const result = checkPackageNames(['prisma', 'tailwindcss']);
    assert.equal(result.hasRisks, true);
    assert.ok(result.risks.length >= 2);
  });

  test('ignores safe packages', () => {
    const result = checkPackageNames(['express', 'lodash', 'axios']);
    assert.equal(result.hasRisks, false);
  });
});

describe('getSafeVersion', () => {
  test('returns safe version for prisma', () => {
    const v = getSafeVersion('prisma');
    assert.ok(v?.includes('6'));
  });

  test('returns null for unknown packages', () => {
    assert.equal(getSafeVersion('express'), null);
  });
});

describe('listRiskyPackages', () => {
  test('returns critical+high packages at default threshold', () => {
    const pkgs = listRiskyPackages('medium');
    assert.ok(pkgs.includes('prisma'));
    assert.ok(pkgs.includes('tailwindcss'));
    assert.ok(pkgs.includes('next'));
  });

  test('only critical packages at critical threshold', () => {
    const pkgs = listRiskyPackages('critical');
    assert.ok(pkgs.includes('prisma'));
    assert.ok(pkgs.includes('tailwindcss'));
    assert.ok(!pkgs.includes('eslint')); // medium
  });
});
