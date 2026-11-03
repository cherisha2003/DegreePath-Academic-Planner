
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const crypto = require("crypto");

const router = express.Router();

// Store PDFs temporarily in memory while extracting text.
// The original PDF is not retained in MySQL.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1
    },
    fileFilter(req, file, callback) {
        if (file.mimetype !== "application/pdf" ||
            !file.originalname.toLowerCase().endsWith(".pdf")) {
            return callback(new Error("Only PDF files are supported."));
        }
        callback(null, true);
    }
});

// Categories describe the source content.
// They are NOT automatically verified degree requirements.
const TOPICS = {
    curriculum: {
        title: "Curriculum & Courses",
        terms: [
            "curriculum", "coursework", "courses",
            "credit hours", "core courses", "electives"
        ]
    },
    requirements: {
        title: "Degree Requirements",
        terms: [
            "degree requirements", "degree completion",
            "program requirements", "required credits",
            "graduation requirements"
        ]
    },
    prerequisites: {
        title: "Prerequisites & Foundation",
        terms: [
            "prerequisite", "pre-requisite",
            "foundation courses", "course waiver"
        ]
    },
    progression: {
        title: "Academic Progression",
        terms: [
            "progression", "minimum grade",
            "academic standing", "retention policy",
            "grading policy"
        ]
    },
    milestones: {
        title: "Graduation & Milestones",
        terms: [
            "graduation", "thesis", "dissertation",
            "qualifier", "capstone", "project option"
        ]
    },
    clinical: {
        title: "Clinical Requirements",
        terms: [
            "clinical", "practicum", "licensure",
            "patient care", "skills laboratory"
        ]
    }
};

// Extract individual pages while preserving approximate text lines.
async function extractPages(buffer) {
    const marker = "DEGREEPATH_PAGE_BOUNDARY_92731";

    const result = await pdfParse(buffer, {
        pagerender: async function(page) {
            const content = await page.getTextContent();
            const lines = [];
            let previousY = null;
            let currentLine = [];

            for (const item of content.items) {
                if (!item.str) continue;

                const y = item.transform?.[5] ?? 0;

                if (previousY !== null && Math.abs(y - previousY) > 3) {
                    if (currentLine.length) {
                        lines.push(currentLine.join(" ").trim());
                    }
                    currentLine = [];
                }

                currentLine.push(item.str);
                previousY = y;
            }

            if (currentLine.length) {
                lines.push(currentLine.join(" ").trim());
            }

            return lines.join("\n") + "\n" + marker;
        }
    });

    const pages = result.text
        .split(marker)
        .map(text => text.trim())
        .filter(Boolean);

    return pages.map((text, index) => ({
        page: index + 1,
        text
    }));
}

// Identify which subjects appear on a page.
// This is keyword classification, not AI interpretation.
function categorizePage(text) {
    const content = text.toLowerCase();
    const matches = [];

    for (const [key, topic] of Object.entries(TOPICS)) {
        if (topic.terms.some(term => content.includes(term))) {
            matches.push(key);
        }
    }

    return matches.length ? matches : ["other"];
}

// Create database tables for uploaded documents and pages.
async function initializeHandbookTables(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS handbook_documents (
            document_id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            filename VARCHAR(255) NOT NULL,
            sha256 CHAR(64) NOT NULL,
            total_pages INT NOT NULL,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_handbook_user (user_id)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS handbook_pages (
            page_id INT AUTO_INCREMENT PRIMARY KEY,
            document_id INT NOT NULL,
            page_number INT NOT NULL,
            extracted_text MEDIUMTEXT NOT NULL,
            categories JSON NOT NULL,
            UNIQUE KEY document_page (document_id, page_number),
            FOREIGN KEY (document_id)
                REFERENCES handbook_documents(document_id)
                ON DELETE CASCADE
        )
    `);
}

// Register all handbook endpoints using the existing MySQL pool.
function createHandbookRouter(db) {

    // Get a list of documents owned by the logged-in student.
    router.get("/", async (req, res, next) => {
        try {
            const [documents] = await db.execute(`
                SELECT document_id, filename, total_pages, uploaded_at
                FROM handbook_documents
                WHERE user_id = ?
                ORDER BY uploaded_at DESC, document_id DESC
            `, [req.session.user.user_id]);

            res.json({ documents });
        } catch (error) {
            next(error);
        }
    });

    // Upload and process a PDF handbook.
    router.post("/", (req, res, next) => {
        upload.single("handbook")(req, res, async error => {
            if (error) {
                return res.status(400).json({
                    error: error.message
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    error: "Please select a PDF document."
                });
            }

            // Check the actual PDF file signature.
            if (req.file.buffer.subarray(0, 5).toString() !== "%PDF-") {
                return res.status(400).json({
                    error: "The uploaded file is not a valid PDF."
                });
            }

            let connection;

            try {
                const pages = await extractPages(req.file.buffer);

                if (!pages.length ||
                    !pages.some(page => page.text.length > 20)) {
                    return res.status(422).json({
                        error: "No readable text was found. This PDF may need OCR."
                    });
                }

                const hash = crypto
                    .createHash("sha256")
                    .update(req.file.buffer)
                    .digest("hex");

                connection = await db.getConnection();
                await connection.beginTransaction();

                const [result] = await connection.execute(`
                    INSERT INTO handbook_documents
                    (user_id, filename, sha256, total_pages)
                    VALUES (?, ?, ?, ?)
                `, [
                    req.session.user.user_id,
                    req.file.originalname.slice(0, 255),
                    hash,
                    pages.length
                ]);

                for (const page of pages) {
                    await connection.execute(`
                        INSERT INTO handbook_pages
                        (document_id, page_number, extracted_text, categories)
                        VALUES (?, ?, ?, ?)
                    `, [
                        result.insertId,
                        page.page,
                        page.text,
                        JSON.stringify(categorizePage(page.text))
                    ]);
                }

                await connection.commit();

                res.status(201).json({
                    message: "Handbook processed successfully.",
                    document_id: result.insertId,
                    total_pages: pages.length
                });
            } catch (error) {
                if (connection) await connection.rollback();

                // Do not return private document contents in errors.
                console.error("PDF processing error:", error);
                res.status(500).json({
                    error: "Could not process this PDF document."
                });
            } finally {
                if (connection) connection.release();
            }
        });
    });

    // Retrieve a document and its page-level extracted text.
    router.get("/:id", async (req, res, next) => {
        try {
            const id = Number(req.params.id);

            if (!Number.isSafeInteger(id) || id <= 0) {
                return res.status(400).json({
                    error: "Invalid document ID."
                });
            }

            const [documents] = await db.execute(`
                SELECT document_id, filename, total_pages, uploaded_at
                FROM handbook_documents
                WHERE document_id = ? AND user_id = ?
            `, [id, req.session.user.user_id]);

            if (!documents.length) {
                return res.status(404).json({
                    error: "Handbook not found."
                });
            }

            const [pages] = await db.execute(`
                SELECT page_number, extracted_text, categories
                FROM handbook_pages
                WHERE document_id = ?
                ORDER BY page_number
            `, [id]);

            res.json({
                document: documents[0],
                pages: pages.map(page => ({
                    page: page.page_number,
                    text: page.extracted_text,
                    categories: typeof page.categories === "string"
                        ? JSON.parse(page.categories)
                        : page.categories
                })),
                topics: TOPICS
            });
        } catch (error) {
            next(error);
        }
    });

    // Delete an uploaded document and its extracted pages.
    router.delete("/:id", async (req, res, next) => {
        try {
            const id = Number(req.params.id);

            if (!Number.isSafeInteger(id) || id <= 0) {
                return res.status(400).json({
                    error: "Invalid document ID."
                });
            }

            const [result] = await db.execute(`
                DELETE FROM handbook_documents
                WHERE document_id = ? AND user_id = ?
            `, [id, req.session.user.user_id]);

            if (!result.affectedRows) {
                return res.status(404).json({
                    error: "Handbook not found."
                });
            }

            res.json({ message: "Handbook deleted." });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

module.exports = {
    createHandbookRouter,
    initializeHandbookTables
};
