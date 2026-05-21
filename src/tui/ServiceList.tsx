import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ProcessState } from '../process/types.js';

interface Props {
  title: string;
  services: Map<string, ProcessState>;
  onSelect: (name: string) => void;
  onClose: () => void;
  filterType?: 'api' | 'web';
}

export function ServiceList({ title, services, onSelect, onClose, filterType }: Props) {
  const allNames = useMemo(
    () => [...services.keys()].filter(n => !filterType || services.get(n)!.svc.type === filterType),
    [services, filterType],
  );
  const [idx, setIdx] = useState(0);
  const [query, setQuery] = useState('');

  const names = useMemo(() => {
    if (!query) return allNames;
    const q = query.toLowerCase();
    return allNames.filter(n => n.toLowerCase().includes(q));
  }, [allNames, query]);

  // Clamp selected index when the list shrinks
  const clamped = Math.min(idx, Math.max(0, names.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      if (query) setQuery('');           // first Esc clears filter
      else onClose();                    // second Esc closes
      return;
    }
    if (key.return) {
      if (names[clamped]) onSelect(names[clamped]!);
      return;
    }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(names.length - 1, i + 1)); return; }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setIdx(0); return; }
    if (input && !key.ctrl && !key.meta && input.length === 1) {
      setQuery(q => q + input);
      setIdx(0);
    }
  }, { isActive: process.stdin.isTTY ?? false });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan"> {title} {query && <Text color="yellow">[{query}]</Text>}</Text>
      {names.length === 0 ? (
        <Text dimColor> (no matches) </Text>
      ) : (
        names.map((name, i) => (
          <Box key={name}>
            <Text color={i === clamped ? 'cyan' : undefined} inverse={i === clamped}> {name} :{services.get(name)!.svc.port} </Text>
          </Box>
        ))
      )}
      <Text dimColor>type to filter  ↑↓ navigate  Enter select  Esc clear/close</Text>
    </Box>
  );
}
