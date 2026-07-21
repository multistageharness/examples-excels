PY      ?= python3
VENV    := .venv
BIN     := $(VENV)/bin
STAMP   := $(VENV)/.installed
SAMPLE  := examples/sample.xlsx

# Override on the command line: make run FILE=book.xlsx ARGS="-o out/changes.xlsx"
FILE ?= $(SAMPLE)
ARGS ?=

.DEFAULT_GOAL := help

.PHONY: help setup install test run run-print run-csv run-json sample clean

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  make run FILE=<workbook.xlsx> ARGS=\"-o out/changes.xlsx\""

setup: $(BIN)/python ## Create the virtualenv

$(BIN)/python:
	$(PY) -m venv $(VENV)
	$(BIN)/python -m pip install --quiet --upgrade pip

install: $(STAMP) ## Install the package and its dev dependencies (editable)

$(STAMP): pyproject.toml | $(BIN)/python
	$(BIN)/python -m pip install --quiet --editable ".[dev]"
	@touch $@

test: install ## Run the test suite
	$(BIN)/pytest

sample: $(SAMPLE) ## Generate the example workbook

$(SAMPLE): scripts/make_sample.py | $(STAMP)
	@$(BIN)/python scripts/make_sample.py $(SAMPLE)

run: install $(SAMPLE) ## Diff a workbook (default: the example) and print what changed
	$(BIN)/xldiff $(FILE) $(ARGS)

run-print: install $(SAMPLE) ## Diff a workbook and print a fixed-width table to stdout
	$(BIN)/xldiff $(FILE) --format table $(ARGS)

run-csv: install $(SAMPLE) ## Diff a workbook and print CSV to stdout
	$(BIN)/xldiff $(FILE) --format csv $(ARGS)

run-json: install $(SAMPLE) ## Diff a workbook and print JSON to stdout
	$(BIN)/xldiff $(FILE) --format json $(ARGS)

clean: ## Remove the virtualenv, build artifacts, and generated files
	rm -rf $(VENV) build dist out src/*.egg-info .pytest_cache $(SAMPLE)
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
