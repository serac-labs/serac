{
  description = "Serac development flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      # serac's own packages (snow-code, snow-code-desktop) carry the
      # Elastic-2.0 license, which nixpkgs classifies as unfree — so the
      # default legacyPackages refuse to evaluate them ("has an unfree
      # license, refusing to evaluate"). Import nixpkgs per-system with a
      # SCOPED allowUnfreePredicate that permits only our own packages,
      # rather than blanket-allowing unfree across the whole package set.
      forEachSystem = f: nixpkgs.lib.genAttrs systems (
        system: f (import nixpkgs {
          inherit system;
          config.allowUnfreePredicate =
            pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "snow-code" "snow-code-desktop" ];
        })
      );
      rev = self.shortRev or self.dirtyShortRev or "dirty";
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_20
            pkg-config
            openssl
            git
          ];
        };
      });

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev;
          };
          snow-code = pkgs.callPackage ./nix/opencode.nix {
            inherit node_modules;
          };
          desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit snow-code;
          };
          # nixpkgs cpu naming to bun cpu naming
          cpuMap = { x86_64 = "x64"; aarch64 = "arm64"; };
          # matrix of node_modules builds - these will always fail due to fakeHash usage
          # but allow computation of the correct hash from any build machine for any cpu/os
          # see the update-nix-hashes workflow for usage
          moduleUpdaters = pkgs.lib.listToAttrs (
            pkgs.lib.concatMap (cpu:
              map (os: {
                name = "${cpu}-${os}_node_modules";
                value = node_modules.override {
                  bunCpu = cpuMap.${cpu};
                  bunOs = os;
                  hash = pkgs.lib.fakeHash;
                };
              }) [ "linux" "darwin" ]
            ) [ "x86_64" "aarch64" ]
          );
        in
        {
          default = snow-code;
          inherit snow-code desktop;
        } // moduleUpdaters
      );
    };
}
