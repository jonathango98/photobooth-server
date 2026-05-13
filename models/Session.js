import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true, match: /^[A-Za-z0-9_-]{1,64}$/ },
  eventId: { type: String, required: true, index: true, match: /^[A-Za-z0-9_-]{1,64}$/ },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Session", sessionSchema);
