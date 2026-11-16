
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { parse } = require("csv-parse/sync");

function createScheduleModule(db) {
    const router = express.Router();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 }
    });

    const wrap = fn => (req, res, next) =>
        Promise.resolve(fn(req, res, next)).catch(next);

    const uid = req => req.session.user.user_id;

    const days = {
        M: "Mon", MON: "Mon", MONDAY: "Mon",
        T: "Tue", TU: "Tue", TUE: "Tue", TUESDAY: "Tue",
        W: "Wed", WED: "Wed", WEDNESDAY: "Wed",
        R: "Thu", TH: "Thu", THU: "Thu", THURSDAY: "Thu",
        F: "Fri", FR: "Fri", FRI: "Fri", FRIDAY: "Fri",
        SA: "Sat", SAT: "Sat", SATURDAY: "Sat",
        SU: "Sun", SUN: "Sun", SUNDAY: "Sun"
    };

    function normalizeDays(value) {
        const text = String(value || "").trim().toUpperCase();

        // GSU compact day notation: MW, TR, MWF.
        if (/^[MTWRF]+$/.test(text)) {
            return [...new Set(
                [...text].map(letter => days[letter])
            )];
        }

        return [...new Set(
            text.split(/[\s,;/&-]+/)
                .filter(Boolean)
                .map(day => days[day])
        )].filter(Boolean);
    }

    function toMinutes(value) {
        const match = /^([01]\d|2[0-3]):([0-5]\d)$/
            .exec(String(value || ""));

        return match
            ? Number(match[1]) * 60 + Number(match[2])
            : null;
    }

    function validate(row) {
        const code = String(row.course_code || "")
            .trim().toUpperCase().slice(0, 30);

        const title = String(row.title || "").trim().slice(0, 150);
        const term = String(row.term || "").trim().slice(0, 40);
        const instructor = String(row.instructor || "")
            .trim().slice(0, 120);
        const room = String(row.room || "").trim().slice(0, 120);
        const crn = String(row.crn || "").trim().slice(0, 30);

        const start = String(row.start_time || "").trim();
        const end = String(row.end_time || "").trim();
        const meetingDays = normalizeDays(row.days);

        const credits = row.credits == null ||
            String(row.credits).trim() === ""
                ? null : Number(row.credits);

        if (!code || !term || !meetingDays.length ||
            toMinutes(start) === null ||
            toMinutes(end) === null ||
            toMinutes(start) >= toMinutes(end) ||
            (credits !== null &&
                (!Number.isFinite(credits) ||
                 credits < 0 || credits > 12))) {
            throw new Error(
                `Invalid meeting for ${code || "a course"}. ` +
                "Check course, term, days and HH:MM times."
            );
        }

        return {
            code, title, term, instructor, room, crn,
            start, end, meetingDays, credits
        };
    }

    async function initializeTables() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS class_meetings (
                meeting_id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                course_code VARCHAR(30) NOT NULL,
                title VARCHAR(150) NOT NULL DEFAULT '',
                term VARCHAR(40) NOT NULL,
                instructor VARCHAR(120) NOT NULL DEFAULT '',
                room VARCHAR(120) NOT NULL DEFAULT '',
                crn VARCHAR(30) NOT NULL DEFAULT '',
                credits DECIMAL(4,1) NULL,
                day_name VARCHAR(3) NOT NULL,
                start_time TIME NOT NULL,
                end_time TIME NOT NULL,
                INDEX idx_student_term (user_id, term)
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS schedule_documents (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                filename VARCHAR(255) NOT NULL,
                extracted_text MEDIUMTEXT NOT NULL,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    async function insertMeeting(conn, userId, meeting) {
        for (const day of meeting.meetingDays) {
            await conn.execute(`
                INSERT INTO class_meetings
                (user_id, course_code, title, term, instructor,
                 room, crn, credits, day_name, start_time, end_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                userId, meeting.code, meeting.title,
                meeting.term, meeting.instructor, meeting.room,
                meeting.crn, meeting.credits, day,
                meeting.start, meeting.end
            ]);
        }
    }

    // List the student's saved meeting records.
    router.get("/", wrap(async (req, res) => {
        const [rows] = await db.execute(`
            SELECT meeting_id, course_code, title, term,
                   instructor, room, crn, credits, day_name,
                   TIME_FORMAT(start_time, '%H:%i') AS start_time,
                   TIME_FORMAT(end_time, '%H:%i') AS end_time
            FROM class_meetings
            WHERE user_id = ?
            ORDER BY term, FIELD(day_name,
                'Mon','Tue','Wed','Thu','Fri','Sat','Sun'),
                start_time
        `, [uid(req)]);

        res.json({ meetings: rows });
    }));

    // Save a manually entered course meeting.
    router.post("/", wrap(async (req, res) => {
        const meeting = validate(req.body);
        const conn = await db.getConnection();

        try {
            await conn.beginTransaction();
            await insertMeeting(conn, uid(req), meeting);
            await conn.commit();
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }

        res.status(201).json({ message: "Class saved." });
    }));

    // Import a CSV with explicit meeting columns.
    router.post("/import-csv", upload.single("file"),
        wrap(async (req, res) => {
            if (!req.file ||
                !req.file.originalname.toLowerCase().endsWith(".csv")) {
                return res.status(400).json({
                    error: "Please upload a CSV file."
                });
            }

            let records;

            try {
                records = parse(req.file.buffer.toString("utf8"), {
                    columns: true,
                    skip_empty_lines: true,
                    trim: true,
                    bom: true
                });
            } catch (error) {
                return res.status(400).json({
                    error: "Unable to read CSV columns."
                });
            }

            if (!records.length || records.length > 250) {
                return res.status(400).json({
                    error: "CSV must contain 1–250 rows."
                });
            }

            let meetings;

            try {
                meetings = records.map(validate);
            } catch (error) {
                return res.status(400).json({
                    error: error.message
                });
            }

            const conn = await db.getConnection();

            try {
                await conn.beginTransaction();

                for (const meeting of meetings) {
                    await insertMeeting(conn, uid(req), meeting);
                }

                await conn.commit();
            } catch (error) {
                await conn.rollback();
                throw error;
            } finally {
                conn.release();
            }

            res.status(201).json({
                message: `${records.length} class rows imported.`
            });
        })
    );

    // PDFs require review before calendar entries are created.
    router.post("/import-pdf", upload.single("file"),
        wrap(async (req, res) => {
            if (!req.file ||
                !req.file.originalname.toLowerCase().endsWith(".pdf") ||
                req.file.buffer.subarray(0, 5).toString() !== "%PDF-") {
                return res.status(400).json({
                    error: "Please upload a valid PDF."
                });
            }

            let text;

            try {
                const pdf = await pdfParse(req.file.buffer);
                text = String(pdf.text || "").trim();
            } catch (error) {
                return res.status(422).json({
                    error: "Could not read text from this PDF."
                });
            }

            if (!text) {
                return res.status(422).json({
                    error: "No selectable text. OCR is needed."
                });
            }

            const [result] = await db.execute(`
                INSERT INTO schedule_documents
                (user_id, filename, extracted_text)
                VALUES (?, ?, ?)
            `, [
                uid(req),
                req.file.originalname.slice(0, 255),
                text
            ]);

            res.status(201).json({
                document_id: result.insertId,
                message: "PDF text extracted. Review the details.",
                text: text.slice(0, 12000)
            });
        })
    );

    // Delete one meeting entry belonging to this student.
    router.delete("/:id", wrap(async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid meeting ID."
            });
        }

        const [result] = await db.execute(`
            DELETE FROM class_meetings
            WHERE meeting_id = ? AND user_id = ?
        `, [id, uid(req)]);

        if (!result.affectedRows) {
            return res.status(404).json({
                error: "Meeting not found."
            });
        }

        res.json({ message: "Meeting deleted." });
    }));

    return { router, initializeTables };
}

module.exports = { createScheduleModule };
