// controllers/eventManagerController.js
const EventManagerApplication = require("../models/EventManagerApplication");
const User = require("../models/user");

const { sendMail } = require("../config/mailer"); // <- your existing mailer

/**
 * Resolve Event Manager dashboard URL used in approval email.
 * Priority:
 *  - EVENT_MANAGER_DASHBOARD_URL
 *  - FRONTEND_URL + "/event-manager"
 *  - fallback hardcoded (you can change)
 */
function getEventManagerDashboardUrl() {
  if (process.env.EVENT_MANAGER_DASHBOARD_URL) {
    return process
      .env
      .EVENT_MANAGER_DASHBOARD_URL
      .replace(/\/+$/, ""); // trim trailing slash
  }

  if (process.env.FRONTEND_URL) {
    const base = process.env.FRONTEND_URL.replace(/\/+$/, "");
    return `${base}/event-manager`;
  }

  // last-resort fallback
  return "https://app.gits.events/event-manager";
}

/**
 * Helper: get current user/actor ids from auth middleware.
 * Adapt this to your real auth shape (req.user, req.auth, etc.)
 */
function getAuthContext(req) {
  const ctx = {
    userId: null,
    actorId: null,
  };

  if (req.user) {
    ctx.userId = req.user._id || req.user.id || null;
    ctx.actorId = req.user.actor || req.user.actorId || null;
  }

  if (!ctx.userId && req.auth) {
    ctx.userId = req.auth._id || req.auth.id || null;
    ctx.actorId = req.auth.actor || req.auth.actorId || null;
  }

  return ctx;
}

/* -------------------------------------------------------------------------- */
/*  USER: APPLY                                                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /event-managers/apply
 */
exports.applyEventManager = async (req, res, next) => {
  try {
    const { userId, actorId } = getAuthContext(req);

    if (!userId && !actorId) {
      return res.status(401).json({
        error: "AUTH_REQUIRED",
        message: "You must be logged in to apply as an Event Manager.",
      });
    }

    const {
      planId,
      planLabel,
      organizerType,
      orgName,
      website,
      country,
      city,
      workEmail,
      phone,
      eventName,
      eventMonth,
      eventMode,
      expectedSize,
      sectors,
      needsTicketing,
      needsB2B,
      needsMarketplace,
      notes,
    } = req.body || {};

    if (!planId || !planLabel) {
      return res.status(400).json({
        error: "MISSING_PLAN",
        message: "Plan information is required.",
      });
    }

    if (!orgName || !workEmail || !eventName || !eventMonth) {
      return res.status(400).json({
        error: "MISSING_FIELDS",
        message:
          "Organization, work email, event name and event month are required.",
      });
    }

    // avoid multiple pending applications for same user/actor
    const pendingFilter = { status: "Pending" };
    if (userId) pendingFilter.user = userId;
    if (!userId && actorId) pendingFilter.actor = actorId;

    const existingPending = await EventManagerApplication.findOne(
      pendingFilter
    ).lean();
    if (existingPending) {
      return res.status(400).json({
        error: "ALREADY_PENDING",
        message:
          "You already have a pending Event Manager application. Please wait for admin review.",
      });
    }

        const doc = await EventManagerApplication.create({
      user: userId || undefined,
      actor: actorId || undefined,
      planId,
      planLabel,
      organizerType,
      orgName,
      website,
      country,
      city,
      workEmail,
      phone,
      eventName,
      eventMonth,
      eventMode,
      expectedSize,
      sectors,
      needsTicketing:
        needsTicketing !== undefined ? !!needsTicketing : true,
      needsB2B: needsB2B !== undefined ? !!needsB2B : true,
      needsMarketplace: !!needsMarketplace,
      notes,
    });

    // 👉 Immediately make this user an Event Manager
    if (userId) {
      try {
        const user = await User.findById(userId);
        if (user) {
          // roles[] array style
          if (Array.isArray(user.roles)) {
            if (!user.roles.includes("EVENT_MANAGER")) {
              user.roles.push("EVENT_MANAGER");
            }
          } else if (typeof user.role === "string") {
            // single role style
            if (user.role !== "EVENT_MANAGER") {
              user.role = "EVENT_MANAGER";
            }
          }
          await user.save();
        }
      } catch (e) {
        console.error("applyEventManager: failed to promote user to EVENT_MANAGER", e);
      }
    }

    return res.status(201).json({
      ok: true,
      application: {
        id: doc._id,
        status: doc.status,
        planId: doc.planId,
        planLabel: doc.planLabel,
        orgName: doc.orgName,
        eventName: doc.eventName,
        eventMonth: doc.eventMonth,
        createdAt: doc.createdAt,
      },
    });

  } catch (err) {
    console.error("applyEventManager error:", err);
    next(err);
  }
};

/* -------------------------------------------------------------------------- */
/*  USER: GET MY APPLICATION                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /event-managers/my-application
 */
exports.getMyEventManagerApplication = async (req, res, next) => {
  try {
    const { userId, actorId } = getAuthContext(req);

    if (!userId && !actorId) {
      return res.status(401).json({
        error: "AUTH_REQUIRED",
        message:
          "You must be logged in to view your Event Manager application.",
      });
    }

    const filter = {};
    if (userId) filter.user = userId;
    if (!userId && actorId) filter.actor = actorId;

    const appDoc = await EventManagerApplication.findOne(filter)
      .sort({ createdAt: -1 })
      .lean();

    if (!appDoc) {
      return res.status(200).json({
        ok: true,
        application: null,
      });
    }

    return res.status(200).json({
      ok: true,
      application: {
        id: appDoc._id,
        status: appDoc.status,
        planId: appDoc.planId,
        planLabel: appDoc.planLabel,
        orgName: appDoc.orgName,
        eventName: appDoc.eventName,
        eventMonth: appDoc.eventMonth,
        createdAt: appDoc.createdAt,
        reviewedAt: appDoc.reviewedAt,
        reviewNotes: appDoc.reviewNotes,
      },
    });
  } catch (err) {
    console.error("getMyEventManagerApplication error:", err);
    next(err);
  }
};

/* -------------------------------------------------------------------------- */
/*  ADMIN: LIST                                                               */
/* -------------------------------------------------------------------------- */

/**
 * ADMIN
 * GET /event-managers/admin/applications?status=Pending|Approved|Rejected|All
 */
exports.adminListApplications = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== "All") {
      if (["Pending", "Approved", "Rejected"].includes(status)) {
        filter.status = status;
      }
    }

    const docs = await EventManagerApplication.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      ok: true,
      applications: docs.map((d) => ({
        id: d._id,
        status: d.status,
        planId: d.planId,
        planLabel: d.planLabel,
        orgName: d.orgName,
        eventName: d.eventName,
        eventMonth: d.eventMonth,
        workEmail: d.workEmail,
        phone: d.phone,
        country: d.country,
        city: d.city,
        eventMode: d.eventMode,
        expectedSize: d.expectedSize,
        sectors: d.sectors,
        notes: d.notes,
        createdAt: d.createdAt,
        reviewedAt: d.reviewedAt,
      })),
    });
  } catch (err) {
    console.error("adminListApplications error:", err);
    next(err);
  }
};

/* -------------------------------------------------------------------------- */
/*  EMAIL HELPER (APPROVED)                                                  */
/* -------------------------------------------------------------------------- */

async function sendEventManagerApprovedEmail(appDoc) {
  if (!appDoc || !appDoc.workEmail) return;

  const dashboardUrl = getEventManagerDashboardUrl();
  const orgName = appDoc.orgName || "your organization";
  const eventName = appDoc.eventName || "your event";
  const planLabel = appDoc.planLabel || "Event Manager";

  const subject = "Your Event Manager access has been approved";

  const textLines = [
    "Hello,",
    "",
    "Your request to become an Event Manager on our platform has been approved.",
    "",
    `Organization: ${orgName}`,
    `Event: ${eventName}`,
    `Plan: ${planLabel}`,
    "",
    "You can now access your Event Manager dashboard here:",
    dashboardUrl,
    "",
    "From this dashboard you will be able to:",
    "- Configure events and programs",
    "- Manage registrations and tickets",
    "- Enable B2B meetings and exhibitors flows (depending on your plan)",
    "",
    "If you have any question, reply to this email.",
    "",
    "– Event team",
  ];

  const text = textLines.join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#111827;line-height:1.5">
      <p>Hello,</p>
      <p>Your request to become an <strong>Event Manager</strong> on our platform has been approved.</p>
      <table style="font-size:13px;margin:8px 0 12px 0">
        <tr><td style="padding-right:8px;color:#6b7280">Organization:</td><td><strong>${orgName}</strong></td></tr>
        <tr><td style="padding-right:8px;color:#6b7280">Event:</td><td>${eventName}</td></tr>
        <tr><td style="padding-right:8px;color:#6b7280">Plan:</td><td>${planLabel}</td></tr>
      </table>
      <p>You can now access your <strong>Event Manager dashboard</strong> here:</p>
      <p>
        <a href="${dashboardUrl}"
           style="display:inline-block;background:#243a66;color:#ffffff;text-decoration:none;font-weight:500;padding:8px 16px;border-radius:999px;">
          Open Event Manager dashboard
        </a>
      </p>
      <p style="font-size:13px;color:#4b5563;margin-top:12px">
        From this dashboard you will be able to:
      </p>
      <ul style="font-size:13px;color:#4b5563;margin-top:4px">
        <li>Configure events, programs and rooms</li>
        <li>Manage registrations and tickets</li>
        <li>Enable B2B meetings and exhibitors flows (depending on your plan)</li>
      </ul>
      <p style="font-size:13px;color:#4b5563;margin-top:12px">
        If you have any question, just reply to this email.
      </p>
      <p style="margin-top:16px">– Event team</p>
    </div>
  `;

  await sendMail(appDoc.workEmail, subject, html, text);
}

/* -------------------------------------------------------------------------- */
/*  ADMIN: UPDATE STATUS (APPROVE / REJECT)                                   */
/* -------------------------------------------------------------------------- */

/**
 * ADMIN
 * PATCH /event-managers/admin/applications/:id/status
 * Body: { status: "Approved" | "Rejected", reviewNotes? }
 */
exports.adminUpdateApplicationStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body || {};

    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({
        error: "INVALID_STATUS",
        message: 'Status must be "Approved" or "Rejected".',
      });
    }

    const doc = await EventManagerApplication.findById(id);
    if (!doc) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Application not found.",
      });
    }

   const prevStatus = doc.status;

    doc.status = status;
    doc.reviewNotes = reviewNotes || undefined;
    doc.reviewedAt = new Date();

    await doc.save();

    // 👉 If rejected, revert user back (remove EVENT_MANAGER)
    if (status === "Rejected" && doc.user) {
      try {
        const user = await User.findById(doc.user);
        if (user) {
          if (Array.isArray(user.roles)) {
            user.roles = user.roles.filter((r) => r !== "EVENT_MANAGER");
            if (!user.roles.length) {
              user.roles = ["USER"];
            }
          } else if (typeof user.role === "string") {
            if (user.role === "EVENT_MANAGER") {
              user.role = "USER";
            }
          }
          await user.save();
        }
      } catch (e) {
        console.error(
          "adminUpdateApplicationStatus: failed to downgrade EVENT_MANAGER user",
          e
        );
      }
    }

    // If we just switched to Approved, send email (only message, no role change)
    if (prevStatus !== "Approved" && doc.status === "Approved") {
      try {
        await sendEventManagerApprovedEmail(doc.toObject());
      } catch (emailErr) {
        console.error(
          "adminUpdateApplicationStatus: failed to send approval email",
          emailErr
        );
        // do not fail the API just because email failed
      }
    }

    return res.status(200).json({
      ok: true,
      application: {
        id: doc._id,
        status: doc.status,
        planId: doc.planId,
        planLabel: doc.planLabel,
        orgName: doc.orgName,
        eventName: doc.eventName,
        eventMonth: doc.eventMonth,
        workEmail: doc.workEmail,
        reviewedAt: doc.reviewedAt,
        reviewNotes: doc.reviewNotes,
      },
    });
  } catch (err) {
    console.error("adminUpdateApplicationStatus error:", err);
    next(err);
  }
};
