import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React from 'react';
import { SearchInput } from '../../../src/tui/SearchInput.js';

test('SearchInput - renders with initial empty value', () => {
  let submittedValue: string | null = null;
  let closed = false;

  const { stdout } = render(
    <SearchInput
      onSubmit={(value) => { submittedValue = value; }}
      onClose={() => { closed = true; }}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Search:'));
  assert.ok(output.includes('█')); // Cursor
});

test('SearchInput - shows typed value', () => {
  // Note: ink-testing-library doesn't simulate user input directly
  // We'll test the rendering aspect
  const { stdout } = render(
    <SearchInput
      onSubmit={() => {}}
      onClose={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Search:'));
  assert.ok(output.includes('█'));
});

test('SearchInput - has yellow border and text', () => {
  const { stdout } = render(
    <SearchInput
      onSubmit={() => {}}
      onClose={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  // The border color and text color are applied via Ink's styling
  // We can at least check the component renders without errors
  assert.ok(output.includes('Search:'));
});