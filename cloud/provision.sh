#!/usr/bin/env bash
# Provisions the whole rig with the Azure CLI. Run from your own machine
# after `az login`.  Each VM has one job; nothing shares a box with anything.
#
#   bash provision.sh create 2     # loadgen + db + 2 app nodes
#   bash provision.sh add-app 3    # add app3 later, for the scaling curve
#   bash provision.sh ips
#   bash provision.sh stop         # deallocate (stops billing, keeps disks)
#   bash provision.sh destroy      # delete everything
set -euo pipefail

RG="${RG:-medusa-perf-lab}"
LOC="${LOC:-centralindia}"
SIZE="${SIZE:-Standard_D2s_v5}"        # D-series: consistent CPU.
                                       # NEVER use B-series here - burstable VMs
                                       # throttle once CPU credits run out and
                                       # your throughput silently decays mid-run.
IMAGE="${IMAGE:-Ubuntu2404}"
ADMIN="${ADMIN:-azureuser}"
VNET=mpl-vnet
SUBNET=mpl-subnet
NSG=mpl-nsg

mk_vm () {
  local name=$1
  az vm create -g "$RG" -n "$name" --image "$IMAGE" --size "$SIZE" \
    --admin-username "$ADMIN" --generate-ssh-keys \
    --vnet-name "$VNET" --subnet "$SUBNET" --nsg "$NSG" \
    --public-ip-sku Standard --os-disk-size-gb 32 \
    --output none
  echo "  created $name"
}

case "${1:-}" in
create)
  APPS="${2:-2}"
  az group create -n "$RG" -l "$LOC" --output none
  az network vnet create -g "$RG" -n "$VNET" --address-prefix 10.10.0.0/16 \
    --subnet-name "$SUBNET" --subnet-prefix 10.10.1.0/24 --output none
  az network nsg create -g "$RG" -n "$NSG" --output none

  MYIP=$(curl -s https://api.ipify.org)
  az network nsg rule create -g "$RG" --nsg-name "$NSG" -n ssh \
    --priority 100 --source-address-prefixes "$MYIP/32" \
    --destination-port-ranges 22 --access Allow --protocol Tcp --output none
  # the rig talks to itself freely; nothing is exposed to the internet
  az network nsg rule create -g "$RG" --nsg-name "$NSG" -n internal \
    --priority 200 --source-address-prefixes 10.10.0.0/16 \
    --destination-port-ranges '*' --access Allow --protocol '*' --output none

  echo "provisioning rig in $LOC ($SIZE)..."
  mk_vm loadgen
  mk_vm db
  for i in $(seq 1 "$APPS"); do mk_vm "app$i"; done
  "$0" ips
  ;;

add-app)
  mk_vm "app${2:?usage: add-app N}"
  "$0" ips
  ;;

ips)
  echo
  printf '%-10s %-16s %s\n' NAME PRIVATE PUBLIC
  az vm list-ip-addresses -g "$RG" -o json | jq -r '.[] |
    [.virtualMachine.name,
     (.virtualMachine.network.privateIpAddresses[0] // "-"),
     (.virtualMachine.network.publicIpAddresses[0].ipAddress // "-")]
    | @tsv' | sort | awk '{printf "%-10s %-16s %s\n", $1, $2, $3}'
  ;;

stop)    az vm deallocate --ids $(az vm list -g "$RG" --query "[].id" -o tsv) --output none
         echo "all VMs deallocated - compute billing stopped" ;;
start)   az vm start --ids $(az vm list -g "$RG" --query "[].id" -o tsv) --output none
         "$0" ips ;;
destroy) az group delete -n "$RG" --yes --no-wait && echo "deleting $RG" ;;
*) sed -n '2,12p' "$0"; exit 1 ;;
esac
