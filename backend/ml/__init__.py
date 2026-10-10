"""
F1 Pitwall — Machine Learning / Statistical Modelling

Tyre degradation modelling: per-stint descriptive fits (Phase 1) and a pooled cross-season
lap-time model (Phase 2).

One architectural rule holds throughout this package:

    Nothing in backend.ml imports FastAPI, handles HTTP, or writes to the database.

It reads through ``backend.db.queries`` and returns plain dicts, dataclasses and numpy
arrays. The HTTP layer lives in ``backend/api/tyres.py``. Keeping that line means every
fitting function here can be unit-tested with a synthetic DataFrame, without a running
server and without a populated DuckDB — which is what makes the regression tests for the
degradation metric and the fuel-correction sign cheap enough to be worth having.

Module map:

    constants.py        every physical and statistical constant, with provenance
    corrections.py      lap-time corrections (fuel; track temperature, pending weather)
    stint_models.py     pure maths: model functions, AICc, robust fit, degradation metric
    degradation.py      Phase 1 orchestration for one session
    pooled_features.py  Phase 2 design matrix and categorical encoders
    pooled_model.py     Phase 2 fit, held-out-race CV, artifact persistence, CLI
    pooled_service.py   Phase 2 API-facing layer: load artifact, predict, residuals
"""
