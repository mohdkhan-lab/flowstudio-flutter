/**
 * FlowStudio Lite — Windows Sleep Blocker
 * Prevents Windows from sleeping or idling during long batch generation runs
 * using kernel32.dll SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED).
 */

const { spawn } = require('child_process');

class SleepBlocker {
  constructor() {
    this._proc = null;
    this._refCount = 0;
  }

  acquire() {
    this._refCount++;
    if (this._proc || process.platform !== 'win32') return;

    try {
      // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001
      const psCmd = `
        $code = @"
        using System;
        using System.Runtime.InteropServices;
        public class WinSleep {
            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern uint SetThreadExecutionState(uint esFlags);
        }
"@
        Add-Type -TypeDefinition $code -Language CSharp
        [WinSleep]::SetThreadExecutionState(0x80000001)
        [Console]::ReadLine()
      `;

      this._proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore']
      });

      this._proc.on('error', () => {
        this._proc = null;
      });

      this._proc.on('exit', () => {
        this._proc = null;
      });
    } catch (e) {
      this._proc = null;
    }
  }

  release() {
    this._refCount = Math.max(0, this._refCount - 1);
    if (this._refCount > 0) return;

    if (this._proc) {
      try {
        if (this._proc.stdin && !this._proc.stdin.destroyed) {
          this._proc.stdin.write('\n');
          this._proc.stdin.end();
        }
        this._proc.kill();
      } catch (e) {}
      this._proc = null;
    }
  }
}

const sleepBlocker = new SleepBlocker();
module.exports = { sleepBlocker, SleepBlocker };
