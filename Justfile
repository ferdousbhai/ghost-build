set shell := ["bash", "-uc"]
set positional-arguments

build:
    pnpm run build

deploy:
    pnpm run deploy
