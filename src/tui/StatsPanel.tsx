import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ProcessState } from '../process/types.js';
import type { ServiceStats } from './hooks/useProcessManager.js';
import { fmtUptime, sortServiceNames, tagColors, redactSecrets, buildProcessArgs, nextRamBannerVisibility } from '../utils.js';
import os from 'node:os';

interface Props {
  states: Map<string, ProcessState>;
  stats: Map<string, ServiceStats>;
  sortMode: string;
  maxNameLen: number;
  height: number;
  focused: boolean;
  scrollOffset: number;
  resetScroll: () => void;
  verbose?: boolean;
}

const H: Record<string, { c: string; color: string }> = {
  up: { c: '●', color: 'green' }, wait: { c: '●', color: 'yellow' },
  down: { c: '●', color: 'red' }, idle: { c: '○', color: 'blue' },
};

/** Matches the constant in ProcessManager — kept in sync manually. */
export const MAX_RESTARTS = 3;

export function isCrashLooped(st: ProcessState): boolean {
  return st.status === 'crashed' && st.restarts >= MAX_RESTARTS;
}

/** How a remote service reads in the status column.
 *
 *  It replaces `running`, which would be true and useless: what matters about
 *  this row is that the process is not here and that a request typed against
 *  its port lands in a shared environment. `ro` marks the ones that refuse
 *  writes — the quiet case, and the rare one, since `readOnly` is off by
 *  default. */
export function remoteLabel(remote: { envName: string; readOnly: boolean }): string {
  const suffix = remote.readOnly ? ' ro' : '';
  return `→${remote.envName}${suffix}`.slice(0, 8);
}

function Row({ name, st, stat, ml, verbose }: { name: string; st: ProcessState; stat?: ServiceStats; ml: number; verbose?: boolean }) {
  const looped = isCrashLooped(st);
  const remote = st.remote;
  // A different glyph, but the health colour is kept: whether the environment
  // answers is still the question the dot exists to answer, and a marker that
  // discarded it would trade one fact for another instead of adding one.
  const indicator = looped
    ? <Text color="red" bold>✖</Text>
    : remote
      ? <Text color={(H[st.health] ?? H['down']!).color}>◈</Text>
      : <Text color={(H[st.health] ?? H['down']!).color}>{(H[st.health] ?? H['down']!).c}</Text>;
  const color = tagColors[st.colorIdx % tagColors.length]!;
  const sc = looped ? 'red' : remote ? 'magenta' : st.status === 'running' ? 'green' : st.status === 'starting' ? 'yellow' : st.status === 'idle' ? 'blue' : 'red';
  const statusLabel = looped ? 'looping' : remote ? remoteLabel(remote) : st.status;
  const up = st.startedAt ? fmtUptime(Date.now() - st.startedAt) : '-';

  if (!verbose) {
    return (
      <Text>
        {indicator} <Text color={color}>{name.padEnd(ml)}</Text> {String(st.svc.port).padStart(5)} <Text color={sc} bold={looped || (!!remote && !remote.readOnly)}>{statusLabel.padEnd(8)}</Text> {(stat?.cpu ?? '-').padStart(6)} {(stat?.mem ?? '-').padStart(8)} {String(st.errors).padStart(3)} {String(st.restarts).padStart(3)} {up.padStart(6)}
      </Text>
    );
  }

  // A remote service has no command to resolve and no extraEnv to redact —
  // what verbose has to show is where its traffic actually goes.
  if (remote) {
    return (
      <Box flexDirection="column">
        <Text>
          {indicator} <Text color={color}>{name.padEnd(ml)}</Text> {String(st.svc.port).padStart(5)} <Text color={sc} bold={!remote.readOnly}>{statusLabel.padEnd(8)}</Text> {'-'.padStart(6)} {'-'.padStart(8)} {String(st.errors).padStart(3)} {String(st.restarts).padStart(3)} {up.padStart(6)}
        </Text>
        <Text dimColor>   → {remote.target}{remote.readOnly ? ' (read-only)' : ''}</Text>
      </Box>
    );
  }

  // Verbose: row + 2 indented lines with the resolved cmd/args and extraEnv.
  const resolvedArgs = buildProcessArgs(st.svc).join(' ');
  const env = redactSecrets(st.svc.extraEnv);
  const envStr = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  return (
    <Box flexDirection="column">
      <Text>
        {indicator} <Text color={color}>{name.padEnd(ml)}</Text> {String(st.svc.port).padStart(5)} <Text color={sc} bold={looped}>{statusLabel.padEnd(8)}</Text> {(stat?.cpu ?? '-').padStart(6)} {(stat?.mem ?? '-').padStart(8)} {String(st.errors).padStart(3)} {String(st.restarts).padStart(3)} {up.padStart(6)}
      </Text>
      <Text dimColor>   cmd: {st.svc.cmd} {resolvedArgs}</Text>
      {envStr && <Text dimColor>   env: {envStr}</Text>}
    </Box>
  );
}

function ColHeader({ ml }: { ml: number }) {
  return <Text bold>H {'Service'.padEnd(ml)} {'Port'.padStart(5)} {'Status'.padEnd(8)} {'CPU'.padStart(6)} {'Mem'.padStart(8)} Err Rst {'Up'.padStart(6)}</Text>;
}

export function StatsPanel({ states, stats, sortMode, maxNameLen, height, focused, scrollOffset, resetScroll, verbose = false }: Props) {
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
  const contentHeight = Math.max(1, height - 2);
  const rowsPerCol = Math.max(1, contentHeight - 2); // header row + col header

  // scrollOffset = topOffset (filas por debajo de la primera, 0 = primera fila)
  const maxRows = Math.max(0, Math.max(apis.length, webs.length) - rowsPerCol);
  const effectiveOffset = scrollOffset === Number.MAX_SAFE_INTEGER
    ? maxRows
    : Math.min(scrollOffset, maxRows);
  const apiStartIndex = Math.min(effectiveOffset, Math.max(0, apis.length - rowsPerCol));
  const webStartIndex = Math.min(effectiveOffset, Math.max(0, webs.length - rowsPerCol));

  const visibleApis = apis.slice(apiStartIndex, apiStartIndex + rowsPerCol);
  const visibleWebs = webs.slice(webStartIndex, webStartIndex + rowsPerCol);

  // Reset scroll cuando cambia el modo de ordenamiento
  useEffect(() => {
    resetScroll();
  }, [sortMode, resetScroll]);

  const totalRowsLong = Math.max(apis.length, webs.length);
  const positionInfo = focused && totalRowsLong > 0
    ? `(${effectiveOffset + 1}-${Math.min(effectiveOffset + rowsPerCol, totalRowsLong)}/${totalRowsLong})`
    : '';
  const scrolled = effectiveOffset > 0;
  const loopedCount = [...states.values()].filter(isCrashLooped).length;
  // Standing, not transient. `readOnly` is off by default, so for as long as
  // these rows are on screen a request typed against one of their ports
  // changes data somebody else is looking at.
  const writableRemotes = [...states.values()].filter(s => s.remote && !s.remote.readOnly);
  const remoteEnvs = [...new Set(writableRemotes.map(s => s.remote!.envName))];

  // RAM pressure banner with hysteresis (80% on, 75% off).
  const ramPct = (parseFloat(usedGB) / parseFloat(totalGB)) * 100;
  const [ramBanner, setRamBanner] = useState(false);
  useEffect(() => {
    setRamBanner(prev => nextRamBannerVisibility(ramPct, prev));
  }, [ramPct]);

  // Top consumers when the banner is active.
  const topConsumers = ramBanner
    ? [...stats.entries()]
        .map(([n, s]) => ({ name: n, mb: parseFloat(s.mem) || 0 }))
        .sort((a, b) => b.mb - a.mb)
        .slice(0, 3)
    : [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'green' : 'gray'} height={height}>
      <Box>
        <Text bold color="green"> Stats {positionInfo}</Text>
        {scrolled && <Text color="yellow"> [SCROLL]</Text>}
        {loopedCount > 0 && <Text color="red" bold> ⚠ {loopedCount} need attention</Text>}

        <Text dimColor> System: {cpus}c Load {load} RAM {usedGB}/{totalGB}GB</Text>
        <Text dimColor> │ </Text>
        <Text dimColor>Stack: CPU {totalCpu.toFixed(1)}% RAM {stackMem} Err {totalErrors} Rst {totalRestarts} Svcs {names.length}</Text>
        {sortMode !== 'name' && <Text dimColor> │ Sort: {sortMode}</Text>}
      </Box>
      {writableRemotes.length > 0 && (
        // Its own line, like the RAM banner and for the same reason: the
        // header row already carries System and Stack, and anything added
        // there is squeezed and wrapped until it reads as noise. This one has
        // to stay legible for as long as it is true — a request typed against
        // one of these ports changes data somebody else is looking at.
        <Box>
          <Text color="magenta" bold> 🌐 {writableRemotes.length} remote → {remoteEnvs.join(', ')} — writes reach it: </Text>
          <Text color="magenta">{writableRemotes.map(s => s.svc.name).join(', ')}</Text>
        </Box>
      )}
      {ramBanner && (
        <Box>
          <Text color="yellow" bold> ⚠ RAM {ramPct.toFixed(0)}% — top: </Text>
          <Text color="yellow">{topConsumers.map(c => `${c.name} ${c.mb.toFixed(0)}MB`).join(', ')}</Text>
        </Box>
      )}
      <Box flexGrow={1}>
        {/* Left column: APIs */}
        <Box flexDirection="column" flexGrow={1} flexBasis={0}>
          <Text bold color="cyan"> APIs ({apis.length})</Text>
          <ColHeader ml={ml} />
          {visibleApis.map(n => (
            <Row key={n} name={n} st={states.get(n)!} stat={stats.get(n)} ml={ml} verbose={verbose} />
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
          {visibleWebs.map(n => (
            <Row key={n} name={n} st={states.get(n)!} stat={stats.get(n)} ml={ml} verbose={verbose} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}
