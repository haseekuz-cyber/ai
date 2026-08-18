# Shared local-model defaults for the launcher scripts.
#
# `src/config.mjs` derives every model role (vision, planner, critic, teacher)
# from a single active model, resolved as
# AI_WORKSTATION_ACTIVE_MODEL || AI_WORKSTATION_LM_STUDIO_MODEL || a fallback.
# `start-all.ps1` reads AI_WORKSTATION_LM_STUDIO_MODEL to decide which weights
# to load into VRAM. Pinning that one variable therefore keeps the loaded model
# and the model the worker asks for from drifting apart: setting only one of the
# two made the launcher load one model while the worker requested another.
#
# gui-owl is a GUI-grounding model. The generic vision model located controls
# correctly but misplaced their coordinates, so clicks landed beside the target.
#
# The guard keeps an externally supplied value, so a caller can still override
# the model for one run without editing this file.

function Set-DefaultLocalModel {
    if (-not $env:AI_WORKSTATION_LM_STUDIO_MODEL) {
        $env:AI_WORKSTATION_LM_STUDIO_MODEL = 'gui-owl-1.5-8b-instruct'
    }
    return $env:AI_WORKSTATION_LM_STUDIO_MODEL
}
