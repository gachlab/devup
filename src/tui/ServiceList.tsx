import React, { useState } from 'react';
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
  const names = [...services.keys()].filter(n => !filterType || services.get(n)!.svc.type === filterType);
  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.escape) onClose();
    else if (key.return) { if (names[idx]) onSelect(names[idx]!); }
    else if (key.upArrow) setIdx(i => Math.max(0, i - 1));
    else if (key.downArrow) setIdx(i => Math.min(names.length - 1, i + 1));
  }, { isActive: process.stdin.isTTY ?? false });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan"> {title} </Text>
      {names.map((name, i) => (
        <Box key={name}>
          <Text color={i === idx ? 'cyan' : undefined} inverse={i === idx}> {name} :{services.get(name)!.svc.port} </Text>
        </Box>
      ))}
      <Text dimColor>↑↓ navigate  Enter select  Esc close</Text>
    </Box>
  );
}
