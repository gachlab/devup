import React from 'react';
import { Box, Text } from 'ink';
import type { ProcessState } from '../process/types.js';
import type { ServiceStats } from './hooks/useProcessManager.js';
import { fmtUptime, sortServiceNames, tagColors } from '../utils.js';
import os from 'node:os';

interface Props {
  states: Map<string, ProcessState>;
  stats: Map<string, ServiceStats>;
  sortMode: string;
  maxNameLen: number;
  height: number;
  focused: boolean;
}

const H: Record<string, { c: string; color: string }> = {
  up: { c: '●', color: 'green' }, wait: { c: '●', color: 'yellow' },
  down: { c: '●', color: 'red' }, idle: { c: '○', color: 'blue' },
};

function Row({ name, st, stat, ml }: { name: string; st: ProcessState; stat?: ServiceStats; ml: number }) {
  const h = H[st.health] ?? H['down']!;
  const color = tagColors[st.colorIdx % tagColors.length]!;
  const sc = st.status === 'running' ? 'green' : st.status === 'starting' ? 'yellow' : st.status === 'idle' ? 'blue' : 'red';
  const up = st.startedAt ? fmtUptime(Date.now() - st.startedAt) : '-';
  return (
    <Text>
      <Text color={h.color}>{h.c}</Text> <Text color={color}>{name.padEnd(ml)}</Text> {String(st.svc.port).padStart(5)} <Text color={sc}>{st.status.padEnd(8)}</Text> {(stat?.cpu ?? '-').padStart(6)} {(stat?.mem ?? '-').padStart(8)} {String(st.errors).padStart(3)} {String(st.restarts).padStart(3)} {up.padStart(6)}
    </Text>
  );
}

function ColHeader({ ml }: { ml: number }) {
  return <Text bold>H {'Service'.padEnd(ml)} {'Port'.padStart(5)} {'Status'.padEnd(8)} {'CPU'.padStart(6)} {'Mem'.padStart(8)} Err Rst {'Up'.padStart(6)}</Text>;
}

export function StatsPanel({ states, stats, sortMode, maxNameLen, height, focused }: Props) {
  const names = [...states.keys()];
  const stObj = Object.fromEntries([...states].map(([k, v]) => [k, { errors: v.errors }]));
  const statsObj = Object.fromEntries([...stats].map(([k, v]) => [k, v]));

  const apis = sortServiceNames(names.filter(n => states.get(n)!.svc.type === 'api'), sortMode, statsObj, stObj);
  const webs = sortServiceNames(names.filter(n => states.get(n)!.svc.type === 'web'), sortMode, statsObj, stObj);

  // System stats
  const cpus = os.cpus().length;
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const usedGB = (parseFloat(totalGB) - os.freemem() / 1024 / 1024 / 1024).toFixed(1);
  const load = os.loadavg()[0]!.toFixed(2);

  // Stack totals
  let totalCpu = 0, totalMemMB = 0, totalErrors = 0, totalRestarts = 0;
  for (const name of names) {
    const s = stats.get(name);
    if (s) {
      const c = parseFloat(s.cpu); if (!isNaN(c)) totalCpu += c;
      const m = parseFloat(s.mem); if (!isNaN(m)) totalMemMB += m;
    }
    totalErrors += states.get(name)?.errors ?? 0;
    totalRestarts += states.get(name)?.restarts ?? 0;
  }
  const stackMem = totalMemMB >= 1024 ? (totalMemMB / 1024).toFixed(2) + ' GB' : totalMemMB.toFixed(1) + ' MB';

  const ml = maxNameLen;
  const contentHeight = height - 2;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'green' : 'gray'} height={height}>
      <Box>
        <Text bold color="green"> Stats </Text>
        <Text dimColor>System: {cpus}c Load {load} RAM {usedGB}/{totalGB}GB</Text>
        <Text dimColor> │ </Text>
        <Text dimColor>Stack: CPU {totalCpu.toFixed(1)}% RAM {stackMem} Err {totalErrors} Rst {totalRestarts} Svcs {names.length}</Text>
        {sortMode !== 'name' && <Text dimColor> │ Sort: {sortMode}</Text>}
      </Box>
      <Box flexGrow={1}>
        {/* Left column: APIs */}
        <Box flexDirection="column" flexGrow={1} flexBasis={0}>
          <Text bold color="cyan"> APIs ({apis.length})</Text>
          <ColHeader ml={ml} />
          {apis.slice(0, contentHeight - 2).map(n => (
            <Row key={n} name={n} st={states.get(n)!} stat={stats.get(n)} ml={ml} />
          ))}
        </Box>
        {/* Separator */}
        <Box flexDirection="column" width={1}>
          {Array.from({ length: contentHeight }, (_, i) => <Text key={i} dimColor>│</Text>)}
        </Box>
        {/* Right column: Webs */}
        <Box flexDirection="column" flexGrow={1} flexBasis={0}>
          <Text bold color="magenta"> Webs ({webs.length})</Text>
          <ColHeader ml={ml} />
          {webs.slice(0, contentHeight - 2).map(n => (
            <Row key={n} name={n} st={states.get(n)!} stat={stats.get(n)} ml={ml} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}
