// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EscrowVault
 * @notice Manages project funding with milestone-based releases
 */
contract EscrowVault is AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");

    IERC20 public immutable token;

    enum ReleaseStatus {
        None,
        Pending,
        Approved,
        Rejected,
        Executed
    }

    struct Deposit {
        uint256 projectId;
        address investor;
        uint256 amount;
        uint256 timestamp;
    }

    struct ReleaseRequest {
        uint256 projectId;
        uint256 milestoneId;
        uint256 amount;
        address recipient;
        uint256 requestTime;
        uint256 approvalCount;
        uint256 rejectionCount;
        ReleaseStatus status;
        uint256 executeAfter; // Timelock
    }

    // Project balances
    mapping(uint256 => uint256) public projectBalances;
    mapping(uint256 => mapping(address => uint256)) public investorBalances;

    // Deposits tracking
    mapping(uint256 => Deposit[]) public projectDeposits;

    // Release requests
    uint256 private _releaseRequestCounter;
    mapping(uint256 => ReleaseRequest) public releaseRequests;
    mapping(uint256 => mapping(address => bool)) public releaseVotes;

    // Configuration
    uint256 public quorumPercentage = 51; // 51% approval required
    uint256 public timelockDuration = 1 days;

    event Deposited(
        uint256 indexed projectId,
        address indexed investor,
        uint256 amount,
        uint256 timestamp
    );
    event ReleaseRequested(
        uint256 indexed requestId,
        uint256 indexed projectId,
        uint256 milestoneId,
        uint256 amount,
        address recipient
    );
    event ReleaseVoteCast(
        uint256 indexed requestId,
        address indexed validator,
        bool approved
    );
    event ReleaseExecuted(
        uint256 indexed requestId,
        uint256 indexed projectId,
        uint256 milestoneId,
        uint256 amount,
        address recipient
    );
    event ReleaseRejected(uint256 indexed requestId);

    /**
     * @notice Constructor
     * @param tokenAddress ERC20 token address for funding
     */
    constructor(address tokenAddress) {
        require(tokenAddress != address(0), "EscrowVault: zero address");
        token = IERC20(tokenAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VALIDATOR_ROLE, msg.sender);
    }

    /**
     * @notice Deposit funds to a project
     * @param projectId Project ID
     * @param amount Amount to deposit
     */
    function deposit(uint256 projectId, uint256 amount) external nonReentrant {
        require(amount > 0, "EscrowVault: zero amount");

        token.safeTransferFrom(msg.sender, address(this), amount);

        projectBalances[projectId] += amount;
        investorBalances[projectId][msg.sender] += amount;

        projectDeposits[projectId].push(
            Deposit({
                projectId: projectId,
                investor: msg.sender,
                amount: amount,
                timestamp: block.timestamp
            })
        );

        emit Deposited(projectId, msg.sender, amount, block.timestamp);
    }

    /**
     * @notice Request release of funds for a milestone
     * @param projectId Project ID
     * @param milestoneId Milestone ID
     * @param amount Amount to release
     * @param recipient Recipient address
     */
    function requestRelease(
        uint256 projectId,
        uint256 milestoneId,
        uint256 amount,
        address recipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256) {
        require(amount > 0, "EscrowVault: zero amount");
        require(recipient != address(0), "EscrowVault: zero recipient");
        require(projectBalances[projectId] >= amount, "EscrowVault: insufficient balance");

        uint256 requestId = ++_releaseRequestCounter;

        releaseRequests[requestId] = ReleaseRequest({
            projectId: projectId,
            milestoneId: milestoneId,
            amount: amount,
            recipient: recipient,
            requestTime: block.timestamp,
            approvalCount: 0,
            rejectionCount: 0,
            status: ReleaseStatus.Pending,
            executeAfter: block.timestamp + timelockDuration
        });

        emit ReleaseRequested(requestId, projectId, milestoneId, amount, recipient);

        return requestId;
    }

    /**
     * @notice Vote on release request
     * @param requestId Release request ID
     * @param approved Approval decision
     */
    function voteRelease(uint256 requestId, bool approved) external onlyRole(VALIDATOR_ROLE) {
        ReleaseRequest storage request = releaseRequests[requestId];
        require(request.status == ReleaseStatus.Pending, "EscrowVault: not pending");
        require(!releaseVotes[requestId][msg.sender], "EscrowVault: already voted");

        releaseVotes[requestId][msg.sender] = true;

        if (approved) {
            request.approvalCount++;
        } else {
            request.rejectionCount++;
        }

        emit ReleaseVoteCast(requestId, msg.sender, approved);

        // Check if quorum reached
        uint256 totalValidators = getRoleMemberCount(VALIDATOR_ROLE);
        uint256 requiredApprovals = (totalValidators * quorumPercentage) / 100;

        if (request.approvalCount >= requiredApprovals) {
            request.status = ReleaseStatus.Approved;
        } else if (request.rejectionCount > (totalValidators - requiredApprovals)) {
            request.status = ReleaseStatus.Rejected;
            emit ReleaseRejected(requestId);
        }
    }

    /**
     * @notice Execute approved release after timelock
     * @param requestId Release request ID
     */
    function executeRelease(uint256 requestId) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        ReleaseRequest storage request = releaseRequests[requestId];
        require(request.status == ReleaseStatus.Approved, "EscrowVault: not approved");
        require(block.timestamp >= request.executeAfter, "EscrowVault: timelock active");
        require(
            projectBalances[request.projectId] >= request.amount,
            "EscrowVault: insufficient balance"
        );

        request.status = ReleaseStatus.Executed;
        projectBalances[request.projectId] -= request.amount;

        token.safeTransfer(request.recipient, request.amount);

        emit ReleaseExecuted(
            requestId,
            request.projectId,
            request.milestoneId,
            request.amount,
            request.recipient
        );
    }

    /**
     * @notice Get project balance
     * @param projectId Project ID
     */
    function getProjectBalance(uint256 projectId) external view returns (uint256) {
        return projectBalances[projectId];
    }

    /**
     * @notice Get investor balance for project
     * @param projectId Project ID
     * @param investor Investor address
     */
    function getInvestorBalance(
        uint256 projectId,
        address investor
    ) external view returns (uint256) {
        return investorBalances[projectId][investor];
    }

    /**
     * @notice Get number of deposits for project
     * @param projectId Project ID
     */
    function getDepositCount(uint256 projectId) external view returns (uint256) {
        return projectDeposits[projectId].length;
    }

    /**
     * @notice Set quorum percentage
     * @param percentage New quorum percentage (1-100)
     */
    function setQuorumPercentage(uint256 percentage) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(percentage > 0 && percentage <= 100, "EscrowVault: invalid percentage");
        quorumPercentage = percentage;
    }

    /**
     * @notice Set timelock duration
     * @param duration New timelock duration in seconds
     */
    function setTimelockDuration(uint256 duration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        timelockDuration = duration;
    }
}
