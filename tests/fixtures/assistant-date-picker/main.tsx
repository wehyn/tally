import "../../../src/app/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantDatePicker, AssistantSelect } from "../../../src/components/assistant-transaction-controls";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("2026-01-31");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [category, setCategory] = useState("food");

  return <main className="assistant-widget chat">
    <section className="assistant-widget-panel has-composer" aria-label="Assistant fixture">
      <header className="assistant-widget-header">Assistant fixture</header>
      <div className="assistant-widget-messages" aria-label="Conversation" data-testid="assistant-messages">
        <AssistantDatePicker
          value={date}
          disabled={false}
          busy={false}
          open={open}
          onOpenChange={setOpen}
          onChange={setDate}
        />
        <AssistantSelect
          label="Category"
          value={category}
          options={[{ value: "food", label: "Food" }, { value: "other", label: "Other" }]}
          disabled={false}
          busy={false}
          open={categoryOpen}
          onOpenChange={setCategoryOpen}
          onChange={setCategory}
        />
        <div aria-hidden="true" style={{ flex: "0 0 1200px" }} />
      </div>
      <footer className="assistant-widget-composer chat" />
    </section>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser fixture root is missing.");
createRoot(root).render(<Fixture />);
