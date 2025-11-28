// controllers/eventManagerDashboardController.js
const mongoose = require("mongoose");
const Event = require("../models/event");
const EventSchedule = require("../models/eventModels/schedule");
const EventGallery = require("../models/eventModels/gallery");
const EventManagerApplication = require("../models/EventManagerApplication");
// NOTE: we do NOT create eventTicket / eventOrganizer here yet;
// tickets stay in event.ticketPlans, organizers in event.draftOrganizers.

/* ────────────────────────── Auth context helper ───────────────────────── */

function getAuthContext(req) {
  const ctx = { userId: null, actorId: null };

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

/**
 * Resolve the Event Manager context:
 * - use req.user._id (normal auth)
 * - find approved EventManagerApplication for this user
 * - take actorId from that application (attendee / speaker)
 *
 * This is the single place where we decide:
 *  "Is this user an Event Manager and which actor is linked?"
 */
async function resolveManagerContext(req) {
  const base = getAuthContext(req);
  console.log(req.user._id);
  const userId = req.userId || req.user._id;
  console.log(userId);
  if (!userId) {
    return { userId: null, actorId: null, application: null };
  }

  const application = await EventManagerApplication.findOne({
    user: userId,
    status: "Approved",
  })
    .select("_id user actor status planId planLabel")
    .lean();

  if (!application) {
    return { userId, actorId: null, application: null };
  }

  const actorId = application.actor || null;

  return { userId, actorId, application };
}

/* ────────────────────────── Util: slugify title ───────────────────────── */

function slugify(input) {
  return (
    String(input || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `event-${Date.now()}`
  );
}

/**
 * Combine a date (YYYY-MM-DD) with a time (HH:MM) to a JS Date.
 * This is a simple helper for schedule creation.
 */
function combineDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  // Store as UTC-ish; adjust later if you have timezone handling
  const iso = `${dateStr}T${timeStr}:00.000Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

/* ────────────────────────── POST /event-manager/dashboard/events/wizard ── */
/**
 * Create a new event from the wizard.
 * Body: { basics, schedule, tickets, organizers, gallery }
 * Only available for approved Event Managers.
 */
exports.createEventFromWizard = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, actorId } = await resolveManagerContext(req);

    if (!userId) {
      return res.status(401).json({
        error: "AUTH_REQUIRED",
        message: "You must be logged in to create an event.",
      });
    }
    actorId= userId;
    if (!actorId) {
      return res.status(403).json({
        error: "NOT_EVENT_MANAGER",
        message:
          "You need an approved Event Manager profile before creating events.",
      });
    }

    const {
      basics = {},
      schedule = [],
      tickets = [],
      organizers = [],
      gallery = [],
    } = req.body || {};

    const {
      title,
      description,
      target,
      startDate,
      endDate,
      city,
      country,
      venueName,
      capacity,
      cover,
    } = basics;

    if (!title || !startDate || !endDate || !target) {
      return res.status(400).json({
        error: "MISSING_FIELDS",
        message: "title, target, startDate and endDate are required.",
      });
    }

    if (!cover) {
      // we can still allow no cover, but your schema may require it
      console.warn(
        "[createEventFromWizard] basics.cover is empty; check event schema required fields."
      );
    }

    const slug = slugify(title);

    // Basic event creation
    const eventDoc = await Event.create(
      [
        {
          title,
          slug,
          description: description || "",
          target,
          startDate,
          endDate,
          city: city || "",
          country: country || "",
          venueName: venueName || "",
          capacity: capacity || undefined,
          cover: cover || undefined,

          // owner: we store both user + actor for future flexibility
          ownerUser: userId || null,
          ownerActor: actorId || null,
          onboardingCompleted: true,
          onboardingSource: "event-manager",

          // ticket plans & draft data (optional schema fields)
          ticketPlans: (tickets || []).map((t) => ({
            name: (t.name || "").slice(0, 80),
            price: t.price != null ? Number(t.price) : 0,
            currency: (t.currency || "EUR").slice(0, 8),
            capacity:
              t.capacity != null && !isNaN(Number(t.capacity))
                ? Number(t.capacity)
                : undefined,
          })),
          draftOrganizers: (organizers || []).map((o) => ({
            name: (o.name || "").slice(0, 120),
            role: (o.type || o.role || "Organizer").slice(0, 80),
            link: (o.link || "").slice(0, 200),
          })),
          draftGallery: (gallery || []).map((g) => ({
            title: (g.title || "").slice(0, 100),
            type: g.type || "image",
            file: (g.file || "").slice(0, 500),
          })),
        },
      ],
      { session }
    );

    const event = eventDoc[0];

    /* ── Create schedule docs from wizard draft ────────────────────────── */

    const scheduleDocs = [];
    if (Array.isArray(schedule) && schedule.length > 0) {
      for (const s of schedule) {
        if (!s.sessionTitle || !s.startTime || !s.endTime) continue;

        const start = combineDateTime(startDate, s.startTime);
        const end = combineDateTime(startDate, s.endTime);
        if (!start || !end) continue;

        scheduleDocs.push({
          id_event: event._id,
          sessionTitle: s.sessionTitle,
          room: s.room || "",
          track: s.track || "",
          // speaker / speakers left empty for now (we’ll connect later)
          startTime: start,
          endTime: end,
        });
      }

      if (scheduleDocs.length) {
        await EventSchedule.insertMany(scheduleDocs, { session });
      }
    }

    /* ── Create gallery docs (for visuals) ─────────────────────────────── */

    const galleryDocs = [];
    if (Array.isArray(gallery) && gallery.length > 0) {
      for (const g of gallery) {
        if (!g.file) continue;
        galleryDocs.push({
          id_event: event._id,
          file: g.file,
          title: g.title || "",
          type: g.type || "image",
        });
      }

      if (galleryDocs.length) {
        await EventGallery.insertMany(galleryDocs, { session });
      }
    }

    await session.commitTransaction();
    session.endSession();

    // Re-shape response for the frontend dashboard
    const responseEvent = {
      id: event._id,
      title: event.title,
      slug: event.slug,
      description: event.description,
      target: event.target,
      startDate: event.startDate,
      endDate: event.endDate,
      city: event.city,
      country: event.country,
      venueName: event.venueName,
      capacity: event.capacity,
      cover: event.cover,
      ticketPlans: event.ticketPlans || [],
      draftOrganizers: event.draftOrganizers || [],
      draftGallery: event.draftGallery || [],
    };

    return res.status(201).json({
      ok: true,
      event: responseEvent,
      schedule: scheduleDocs,
      gallery: galleryDocs,
      // This will feed header / aside later:
      meta: {
        stats: {
          sessionsCount: scheduleDocs.length,
          ticketTypesCount: (event.ticketPlans || []).length,
          mediaCount: galleryDocs.length,
          organizersCount: (event.draftOrganizers || []).length,
        },
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error("createEventFromWizard error:", err);
    next(err);
  }
};

/* ────────────────────────── GET /event-manager/dashboard/events ─────────── */
/**
 * List events owned by the current Event Manager (very light list).
 * Uses user -> EventManagerApplication -> actor mapping.
 */
exports.listMyEventsForManager = async (req, res, next) => {
  try {
    const { userId, actorId } = await resolveManagerContext(req);

    if (!userId) {
      return res.status(401).json({
        error: "AUTH_REQUIRED",
        message: "You must be logged in to view your events.",
      });
    }

    if (!actorId) {
      return res.status(403).json({
        error: "NOT_EVENT_MANAGER",
        message: "You need an approved Event Manager profile to view events.",
      });
    }

    const filter = {
      ownerUser: userId,
      ownerActor: actorId,
    };

    const docs = await Event.find(filter)
      .sort({ startDate: 1 })
      .select(
        "title slug startDate endDate city country cover onboardingCompleted isPublished"
      )
      .lean();

    const events = docs.map((e) => ({
      id: e._id,
      title: e.title,
      slug: e.slug,
      startDate: e.startDate,
      endDate: e.endDate,
      city: e.city,
      country: e.country,
      cover: e.cover,
      onboardingCompleted: !!e.onboardingCompleted,
      isPublished: !!e.isPublished,
    }));

    return res.status(200).json({ ok: true, events });
  } catch (err) {
    console.error("listMyEventsForManager error:", err);
    next(err);
  }
};

/* ────────────────────────── GET /event-manager/dashboard/events/:id ─────── */
/**
 * Load a single event + schedule + media (+ header/aside meta) for dashboard.
 * Secured by user -> EventManagerApplication -> actor -> event.ownerActor.
 */
exports.getEventForManagerDashboard = async (req, res, next) => {
  try {
    const { userId, actorId } = await resolveManagerContext(req);

    if (!userId) {
      return res.status(401).json({
        error: "AUTH_REQUIRED",
        message: "You must be logged in to view this event.",
      });
    }

    if (!actorId) {
      return res.status(403).json({
        error: "NOT_EVENT_MANAGER",
        message: "You need an approved Event Manager profile to view events.",
      });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "INVALID_ID" });
    }

    const event = await Event.findById(id).lean();
    if (!event) {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    // Ownership guard (strict: match both ownerUser + ownerActor)
    if (
      event.ownerUser?.toString() !== String(userId || "") ||
      event.ownerActor?.toString() !== String(actorId || "")
    ) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "You are not allowed to access this event.",
      });
    }

    const [scheduleDocs, galleryDocs] = await Promise.all([
      EventSchedule.find({ id_event: event._id })
        .sort({ startTime: 1 })
        .lean(),
      EventGallery.find({ id_event: event._id })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const cleanSchedule = scheduleDocs.map((s) => ({
      id: s._id,
      sessionTitle: s.sessionTitle,
      room: s.room,
      track: s.track,
      startTime: s.startTime,
      endTime: s.endTime,
    }));

    const cleanGallery = galleryDocs.map((g) => ({
      id: g._id,
      file: g.file,
      title: g.title,
      type: g.type,
    }));

    const eventPayload = {
      id: event._id,
      title: event.title,
      slug: event.slug,
      description: event.description,
      target: event.target,
      startDate: event.startDate,
      endDate: event.endDate,
      city: event.city,
      country: event.country,
      venueName: event.venueName,
      capacity: event.capacity,
      cover: event.cover,
      ticketPlans: event.ticketPlans || [],
      draftOrganizers: event.draftOrganizers || [],
      draftGallery: event.draftGallery || [],
      onboardingCompleted: !!event.onboardingCompleted,
      isPublished: !!event.isPublished,
    };

    // This structure is meant to feed your new header & aside nav
    const header = {
      title: event.title,
      dates: {
        startDate: event.startDate,
        endDate: event.endDate,
      },
      location: {
        city: event.city,
        country: event.country,
      },
      stats: {
        sessionsCount: cleanSchedule.length,
        ticketTypesCount: (event.ticketPlans || []).length,
        mediaCount: cleanGallery.length,
        organizersCount: (event.draftOrganizers || []).length,
      },
    };

    const aside = {
      primaryEventCard: {
        title: event.title,
        target: event.target,
        capacity: event.capacity,
        cover: event.cover,
        chipDates: header.dates,
        chipLocation: header.location,
      },
      // tab ids must match what you use on frontend
      tabs: [
        { id: "basics", label: "Event data" },
        { id: "schedule", label: "Schedule" },
        { id: "tickets", label: "Tickets" },
        { id: "organizers", label: "Organizers & gallery" },
      ],
    };

    return res.status(200).json({
      ok: true,
      event: eventPayload,
      schedule: cleanSchedule,
      gallery: cleanGallery,
      header,
      aside,
    });
  } catch (err) {
    console.error("getEventForManagerDashboard error:", err);
    next(err);
  }
};
exports.updateEventForManagerDashboard = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, actorId } = await resolveManagerContext(req);

    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({
        error: "AUTH_REQUIRED",
        message: "You must be logged in to update this event.",
      });
    }

    if (!actorId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        error: "NOT_EVENT_MANAGER",
        message: "You need an approved Event Manager profile to update events.",
      });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: "INVALID_ID" });
    }

    const event = await Event.findById(id).session(session);
    if (!event) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    // Ownership guard
    if (
      event.ownerUser?.toString() !== String(userId || "") ||
      event.ownerActor?.toString() !== String(actorId || "")
    ) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "You are not allowed to modify this event.",
      });
    }

    const {
      basics = null,
      schedule = null,
      tickets = null,
      organizers = null,
      gallery = null,
    } = req.body || {};

    /* ── basics ───────────────────────────────────────────────────── */

    if (basics && typeof basics === "object") {
      const {
        title,
        description,
        target,
        startDate,
        endDate,
        city,
        country,
        venueName,
        capacity,
        cover,
      } = basics;

      if (title !== undefined && title !== null) {
        event.title = String(title);
        // Optional: update slug when title changes
        event.slug = slugify(title);
      }

      if (description !== undefined) event.description = String(description || "");
      if (target !== undefined) event.target = String(target || "");
      if (startDate) event.startDate = new Date(startDate);
      if (endDate) event.endDate = new Date(endDate);
      if (city !== undefined) event.city = String(city || "");
      if (country !== undefined) event.country = String(country || "");
      if (venueName !== undefined) event.venueName = String(venueName || "");
      if (cover !== undefined) event.cover = cover || "";

      if (capacity !== undefined) {
        const num = Number(capacity);
        event.capacity = !Number.isNaN(num) && num > 0 ? num : undefined;
      }
    }

    /* ── tickets ──────────────────────────────────────────────────── */

    if (Array.isArray(tickets)) {
      event.ticketPlans = tickets
        .filter((t) => t && (t.name || "").trim())
        .map((t) => ({
          name: String(t.name || "").slice(0, 80),
          price:
            t.price !== undefined && t.price !== null
              ? Number(t.price) || 0
              : 0,
          currency: String(t.currency || "EUR").slice(0, 8),
          capacity:
            t.capacity !== undefined && t.capacity !== null && t.capacity !== ""
              ? Number(t.capacity) || undefined
              : undefined,
        }));
    }

    /* ── organizers ──────────────────────────────────────────────── */

    if (Array.isArray(organizers)) {
      event.draftOrganizers = organizers
        .filter((o) => o && (o.name || "").trim())
        .map((o) => ({
          name: String(o.name || "").slice(0, 120),
          role: String(o.role || "Organizer").slice(0, 80),
          link: String(o.link || "").slice(0, 200),
        }));
    }

    /* ── gallery (draft) + EventGallery docs ─────────────────────── */

    if (Array.isArray(gallery)) {
      // Update draftGallery snapshot on the event document
      event.draftGallery = gallery
        .filter((g) => g && (g.file || "").trim())
        .map((g) => ({
          title: String(g.title || "").slice(0, 100),
          type: g.type || "image",
          file: String(g.file || "").slice(0, 500),
        }));

      // Sync main EventGallery collection
      await EventGallery.deleteMany({ id_event: event._id }).session(session);

      const galleryDocs = gallery
        .filter((g) => g && (g.file || "").trim())
        .map((g) => ({
          id_event: event._id,
          file: g.file,
          title: g.title || "",
          type: g.type || "image",
        }));

      if (galleryDocs.length) {
        await EventGallery.insertMany(galleryDocs, { session });
      }
    }

    /* ── schedule ────────────────────────────────────────────────── */

    if (Array.isArray(schedule)) {
      await EventSchedule.deleteMany({ id_event: event._id }).session(session);

      const baseDate =
        (basics && basics.startDate) || event.startDate || event.endDate;

      const scheduleDocs = [];

      for (const s of schedule) {
        if (!s || !s.sessionTitle || !s.startTime || !s.endTime) continue;

        const start = combineDateTime(baseDate, s.startTime);
        const end = combineDateTime(baseDate, s.endTime);
        if (!start || !end) continue;

        scheduleDocs.push({
          id_event: event._id,
          sessionTitle: s.sessionTitle,
          room: s.room || "",
          track: s.track || "",
          startTime: start,
          endTime: end,
        });
      }

      if (scheduleDocs.length) {
        await EventSchedule.insertMany(scheduleDocs, { session });
      }
    }

    await event.save({ session });

    await session.commitTransaction();
    session.endSession();

    // Reuse the GET controller to build the response payload
    return exports.getEventForManagerDashboard(req, res, next);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error("updateEventForManagerDashboard error:", err);
    next(err);
  }
};