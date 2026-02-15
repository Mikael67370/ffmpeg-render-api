import express from "express";
import bodyParser from "body-parser";
import fs from "fs-extra";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(bodyParser.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  try {
    const { pipeline } = req.body;

    if (!pipeline || !Array.isArray(pipeline)) {
      return res.status(400).json({ error: "Pipeline manquant ou invalide" });
    }

    const jobId = uuidv4();
    const workDir = `/tmp/job_${jobId}`;
    await fs.mkdirp(workDir);

    for (const step of pipeline) {
      await new Promise((resolve, reject) => {
        exec(step.command, { cwd: workDir }, (error, stdout, stderr) => {
          if (error) {
            console.error(stderr);
            reject(stderr);
          } else {
            resolve(stdout);
          }
        });
      });
    }

    const outputFile = `${workDir}/final_output.mp4`;

    if (!(await fs.pathExists(outputFile))) {
      return res.status(500).json({ error: "Vidéo non générée" });
    }

    res.sendFile(outputFile);

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg API running on port ${PORT}`);
});
