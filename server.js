// =============================================================================
// FFmpeg Render API — Production Service for n8n Video Rendering Automation
// =============================================================================
// This service receives a JSON pipeline of shell commands (primarily FFmpeg),
// executes them sequentially in an isolated temp directory, and returns the
// rendered output file. Designed to run inside Docker on Render.com or any
// container platform.
// =============================================================================

import express from "express";
import fs from "fs-extra";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";
import path from "path";

// =============================================================================
// Configuration — centralised, environment-driven defaults
// =============================================================================

// Maximum JSON body size. n8n may send base64-encoded audio/images inline,
// so we allow a generous limit. Override via env var if needed.
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || "100mb";

// Per-step execution timeout in milliseconds (default 4 minutes).
// Kept under Render free-plan limits. Override via env var for paid plans.
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS, 10) || 240_000;

// Global job timeout — kills the entire request if exceeded (default 14 min).
// Render free plan enforces ~15 min max request lifetime. We set 14 min to
// leave a 1-min buffer for cleanup and response transmission.
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS, 10) || 840_000;

// Port — Render injects PORT; fallback to 3000 for local dev.
const PORT = process.env.PORT || 3000;

// =============================================================================
// Express application setup
// =============================================================================

const app = express();

// Parse JSON bodies with the configured size limit.
// body-parser is bundled inside Express >=4.16, so no separate import needed.
app.use(express.json({ limit: MAX_BODY_SIZE }));

// =============================================================================
// Health-check endpoint — required by Render and useful for uptime monitors
// =============================================================================

app.get("/health", async (_req, res) => {
  // Probe FFmpeg binary — confirms it is installed and callable inside Docker.
  let ffmpegVersion = null;
  let ffmpegStatus = "not found";
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      exec("ffmpeg -version", { timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) reject({ error: err, stdout, stderr });
        else resolve({ stdout, stderr });
      });
    });
    // Extract first line: "ffmpeg version X.Y.Z ..."
    ffmpegVersion = stdout.split("\n")[0].trim();
    ffmpegStatus = "ok";
  } catch (_) {
    ffmpegStatus = "unavailable — FFmpeg binary not found in PATH";
  }

  res.status(ffmpegStatus === "ok" ? 200 : 503).json({
    status: ffmpegStatus === "ok" ? "ok" : "degraded",
    ffmpeg: ffmpegStatus,
    ffmpegVersion,
    timestamp: new Date().toISOString(),
    config: {
      stepTimeoutMs: STEP_TIMEOUT_MS,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      maxBodySize: MAX_BODY_SIZE,
    },
  });
});

// =============================================================================
// Helper: structured logger with ISO timestamps
// =============================================================================

function log(level, jobId, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    jobId: jobId || "system",
    message,
    ...meta,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// =============================================================================
// Helper: execute a single shell command with timeout and promise wrapper
// =============================================================================

function execStep(command, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        // Increase maxBuffer to 50 MB — FFmpeg can produce verbose stderr.
        maxBuffer: 50 * 1024 * 1024,
        // Use /bin/sh explicitly for predictable behaviour inside Docker.
        shell: "/bin/sh",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({ error, stdout, stderr });
        } else {
          resolve({ stdout, stderr });
        }
      }
    );

    // Safety net: if the child process hangs beyond timeout, force-kill it.
    // Node's built-in timeout sends SIGTERM; we add a hard SIGKILL fallback.
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {
        /* already dead */
      }
    }, timeoutMs + 5000);

    child.on("close", () => clearTimeout(killTimer));
  });
}

// =============================================================================
// Helper: resolve the command string from a pipeline step object
// Supports both { cmd: "..." } and { command: "..." } for flexibility.
// =============================================================================

function resolveCommand(step) {
  if (typeof step === "string") return step;
  if (step && typeof step === "object") {
    if (typeof step.cmd === "string") return step.cmd;
    if (typeof step.command === "string") return step.command;
  }
  return null;
}

// =============================================================================
// Helper: detect and handle the WRITE_BINARY_TO special instruction
// Pattern: "WRITE_BINARY_TO:/some/path/file.ext"
// Reads base64 data from req.body.binaryData, decodes it, writes to path.
// =============================================================================

const WRITE_BINARY_RE = /^WRITE_BINARY_TO:(.+)$/;

async function handleBinaryWrite(targetPath, binaryData, jobId) {
  if (!binaryData || typeof binaryData !== "string") {
    throw new Error(
      'WRITE_BINARY_TO requires req.body.binaryData (base64 string). '
      + 'In n8n, send: { "pipeline": [...], "binaryData": "{{ $binary.data.data }}" }'
    );
  }

  // Ensure the parent directory exists before writing.
  const dir = path.dirname(targetPath);
  await fs.mkdirp(dir);

  const buffer = Buffer.from(binaryData, "base64");
  await fs.writeFile(targetPath, buffer);

  log("info", jobId, `Binary data written (${buffer.length} bytes)`, {
    targetPath,
  });
}

// =============================================================================
// Helper: validate that a resolved command is safe to execute
// Rejects non-string values to prevent command injection via objects/arrays.
// =============================================================================

function validateCommand(command, stepIndex) {
  if (typeof command !== "string") {
    throw new Error(
      `Step ${stepIndex}: resolved command is not a string — potential injection blocked`
    );
  }
  if (command.trim().length === 0) {
    throw new Error(`Step ${stepIndex}: command is empty`);
  }
}

// =============================================================================
// Helper: cleanup job working directory (fire-and-forget)
// =============================================================================

async function cleanupWorkDir(workDir, jobId) {
  try {
    await fs.remove(workDir);
    log("info", jobId, "Work directory cleaned up", { workDir });
  } catch (err) {
    // Non-fatal — log and move on. The OS /tmp cleaner will handle it.
    log("error", jobId, "Failed to clean up work directory", {
      workDir,
      error: err.message,
    });
  }
}

// =============================================================================
// POST /render — main rendering endpoint
// =============================================================================

app.post("/render", async (req, res) => {
  const jobId = uuidv4();
  const workDir = `/tmp/job_${jobId}`;

  // Job-level timeout: abort the entire request if it exceeds the limit.
  const jobTimer = setTimeout(() => {
    log("error", jobId, "Job timed out — aborting", {
      timeoutMs: JOB_TIMEOUT_MS,
    });
    if (!res.headersSent) {
      res.status(504).json({
        error: "Job exceeded maximum allowed time",
        jobId,
        timeoutMs: JOB_TIMEOUT_MS,
      });
    }
  }, JOB_TIMEOUT_MS);

  try {
    log("info", jobId, "Render job started");

    // -------------------------------------------------------------------------
    // 1. Input validation
    // -------------------------------------------------------------------------

    const { pipeline, output_path, binaryData } = req.body;

    if (!pipeline || !Array.isArray(pipeline)) {
      clearTimeout(jobTimer);
      log("error", jobId, "Invalid or missing pipeline");
      return res.status(400).json({
        error: "Request body must include a 'pipeline' array",
        jobId,
      });
    }

    if (pipeline.length === 0) {
      clearTimeout(jobTimer);
      log("error", jobId, "Pipeline is empty");
      return res.status(400).json({
        error: "Pipeline array must contain at least one step",
        jobId,
      });
    }

    // output_path is optional — defaults to <workDir>/final_output.mp4
    const outputFile = output_path
      ? path.resolve(output_path)
      : path.join(workDir, "final_output.mp4");

    log("info", jobId, "Pipeline received", {
      steps: pipeline.length,
      outputFile,
    });

    // -------------------------------------------------------------------------
    // 1b. Pre-flight: if any step uses WRITE_BINARY_TO, verify binaryData now
    // -------------------------------------------------------------------------

    const hasBinaryStep = pipeline.some((s) => {
      const cmd = resolveCommand(s);
      return cmd && WRITE_BINARY_RE.test(cmd);
    });

    if (hasBinaryStep && (!binaryData || typeof binaryData !== "string")) {
      clearTimeout(jobTimer);
      log("error", jobId, "Pipeline contains WRITE_BINARY_TO but binaryData is missing");
      return res.status(400).json({
        error:
          'Pipeline contains a WRITE_BINARY_TO step but req.body.binaryData is missing or not a string. '
          + 'In n8n, send: { "pipeline": [...], "binaryData": "{{ $binary.data.data }}" }',
        jobId,
      });
    }

    // -------------------------------------------------------------------------
    // 2. Create isolated working directory
    // -------------------------------------------------------------------------

    await fs.mkdirp(workDir);
    log("info", jobId, "Work directory created", { workDir });

    // -------------------------------------------------------------------------
    // 3. Execute pipeline steps sequentially
    // -------------------------------------------------------------------------

    for (let i = 0; i < pipeline.length; i++) {
      const step = pipeline[i];
      const stepLabel = `Step ${i + 1}/${pipeline.length}`;

      // --- Check for WRITE_BINARY_TO special instruction ---
      const rawCommand = resolveCommand(step);

      if (rawCommand === null) {
        // Malformed step — log a warning and skip to avoid crashing the job.
        log("error", jobId, `${stepLabel}: malformed step — skipping`, {
          step,
        });
        continue;
      }

      const binaryMatch = rawCommand.match(WRITE_BINARY_RE);

      if (binaryMatch) {
        // Handle binary write instruction
        const targetPath = binaryMatch[1].trim();
        log("info", jobId, `${stepLabel}: WRITE_BINARY_TO instruction`, {
          targetPath,
        });
        await handleBinaryWrite(targetPath, binaryData, jobId);
        continue;
      }

      // --- Standard shell command execution ---
      validateCommand(rawCommand, i + 1);

      log("info", jobId, `${stepLabel}: executing`, {
        command: rawCommand.substring(0, 200), // truncate for log safety
      });

      const startTime = Date.now();

      try {
        const { stdout, stderr } = await execStep(
          rawCommand,
          workDir,
          STEP_TIMEOUT_MS
        );

        const durationMs = Date.now() - startTime;

        log("info", jobId, `${stepLabel}: completed in ${durationMs}ms`, {
          durationMs,
          // Log last 500 chars of stderr — FFmpeg writes progress here.
          stderr: stderr ? stderr.slice(-500) : "",
        });
      } catch (execErr) {
        const durationMs = Date.now() - startTime;

        log("error", jobId, `${stepLabel}: FAILED after ${durationMs}ms`, {
          durationMs,
          error: execErr.error?.message || "Unknown execution error",
          stderr: execErr.stderr ? execErr.stderr.slice(-1000) : "",
          stdout: execErr.stdout ? execErr.stdout.slice(-500) : "",
        });

        clearTimeout(jobTimer);

        // Clean up before returning the error response.
        cleanupWorkDir(workDir, jobId);

        return res.status(500).json({
          error: `Pipeline failed at step ${i + 1}`,
          jobId,
          step: i + 1,
          detail: execErr.stderr
            ? execErr.stderr.slice(-1000)
            : execErr.error?.message || "Unknown error",
        });
      }
    }

    // -------------------------------------------------------------------------
    // 4. Verify output file exists and return it
    // -------------------------------------------------------------------------

    if (!(await fs.pathExists(outputFile))) {
      clearTimeout(jobTimer);
      log("error", jobId, "Output file not found after pipeline completed", {
        outputFile,
      });

      cleanupWorkDir(workDir, jobId);

      return res.status(500).json({
        error: "Rendering completed but output file was not produced",
        jobId,
        expectedPath: outputFile,
      });
    }

    const stat = await fs.stat(outputFile);
    log("info", jobId, "Output file ready", {
      outputFile,
      sizeBytes: stat.size,
    });

    clearTimeout(jobTimer);

    // Stream the file to the client, then clean up.
    res.sendFile(outputFile, (err) => {
      if (err) {
        log("error", jobId, "Error sending output file", {
          error: err.message,
        });
        // Only send error response if headers haven't been sent yet.
        if (!res.headersSent) {
          res.status(500).json({
            error: "Failed to send output file",
            jobId,
          });
        }
      } else {
        log("info", jobId, "Output file sent successfully");
      }

      // Clean up the working directory after the file has been sent.
      cleanupWorkDir(workDir, jobId);
    });
  } catch (err) {
    // Catch-all for unexpected errors — ensures the API never crashes.
    clearTimeout(jobTimer);
    log("error", jobId, "Unhandled error in render pipeline", {
      error: err.message,
      stack: err.stack,
    });

    cleanupWorkDir(workDir, jobId);

    if (!res.headersSent) {
      res.status(500).json({
        error: "Internal server error",
        jobId,
        detail: err.message,
      });
    }
  }
});

// =============================================================================
// Global uncaught exception / rejection handlers — prevent silent crashes
// =============================================================================

process.on("uncaughtException", (err) => {
  log("error", null, "Uncaught exception", {
    error: err.message,
    stack: err.stack,
  });
  // In production, let the container orchestrator restart us.
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("error", null, "Unhandled promise rejection", {
    reason: reason?.toString?.() || reason,
  });
});

// =============================================================================
// Start server
// =============================================================================

app.listen(PORT, "0.0.0.0", () => {
  log("info", null, "FFmpeg Render API started", {
    port: PORT,
    stepTimeoutMs: STEP_TIMEOUT_MS,
    jobTimeoutMs: JOB_TIMEOUT_MS,
    maxBodySize: MAX_BODY_SIZE,
    nodeVersion: process.version,
  });
});
