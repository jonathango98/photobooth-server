import mongoose from "mongoose";

const slotSchema = new mongoose.Schema(
  { x: Number, y: Number },
  { _id: false }
);

const templateSchema = new mongoose.Schema(
  {
    name: String,
    file: String,
    preview: String,
    width: Number,
    height: Number,
    slots: [slotSchema],
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema({
  event_id: { type: String, required: true, unique: true, index: true },
  event_name: { type: String, required: true },
  templates: [templateSchema],
  capture: {
    totalShots: Number,
    photoWidth: Number,
    photoHeight: Number,
  },
  countdown: {
    seconds: Number,
    stepMs: Number,
  },
  gestureTrigger: {
    enabled: { type: Boolean, default: false },
    gestureType: { type: String, default: "peace" },
    holdDuration: { type: Number, default: 1000 },
    detectionFps: { type: Number, default: 10 },
  },
  qr: {
    size: Number,
    margin: Number,
  },
  background_url: { type: String, default: "" },
  admin_password: { type: String, default: "" },
  is_active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

eventSchema.pre("save", async function () {
  this.updated_at = new Date();
});

export default mongoose.model("Event", eventSchema);
