"""Prompt Effect UI mount. Prompt changes are explicit browser actions only."""

import gradio as gr
from modules import script_callbacks

PEF_TAB_ID = "pef_prompt_effect"


def pef_on_ui_tabs():
    with gr.Blocks() as pef_ui:
        gr.HTML(
            '<div id="pef-app" class="pef-app">'
            '<p class="pef-loading">Loading Prompt Effect…</p></div>',
            elem_id="pef_mount",
        )
    return [(pef_ui, "Prompt Effect", PEF_TAB_ID)]


script_callbacks.on_ui_tabs(pef_on_ui_tabs)
