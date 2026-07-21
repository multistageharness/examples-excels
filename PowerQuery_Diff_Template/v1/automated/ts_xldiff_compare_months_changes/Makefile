SAMPLE := examples/sample.xlsx
STAMP  := node_modules/.installed

# Override on the command line: make run FILE=book.xlsx ARGS="-o out/changes.xlsx"
FILE ?= $(SAMPLE)
ARGS ?=

.DEFAULT_GOAL := help

.PHONY: help install build test run run-print run-csv run-json sample clean

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  make run FILE=<workbook.xlsx> ARGS=\"-o out/changes.xlsx\""

install: $(STAMP) ## Install dependencies

$(STAMP): package.json
	npm install
	@touch $@

build: install ## Compile TypeScript to dist/
	npm run build

test: install ## Run the test suite
	npm test

sample: $(SAMPLE) ## Generate the example workbook

$(SAMPLE): scripts/make-sample.ts | $(STAMP)
	@npx tsx scripts/make-sample.ts $(SAMPLE)

run: install $(SAMPLE) ## Diff a workbook (default: the example) and print what changed
	@npx tsx src/cli.ts $(FILE) $(ARGS)

run-print: install $(SAMPLE) ## Diff a workbook and print a fixed-width table to stdout
	@npx tsx src/cli.ts $(FILE) --format table $(ARGS)

run-csv: install $(SAMPLE) ## Diff a workbook and print CSV to stdout
	@npx tsx src/cli.ts $(FILE) --format csv $(ARGS)

run-json: install $(SAMPLE) ## Diff a workbook and print JSON to stdout
	@npx tsx src/cli.ts $(FILE) --format json $(ARGS)

clean: ## Remove installed deps, build artifacts, and generated files
	rm -rf node_modules dist out coverage $(SAMPLE)
